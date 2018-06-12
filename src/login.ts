import color from '@heroku-cli/color'
import * as Heroku from '@heroku-cli/schema'
import * as Config from '@oclif/config'
import ux from 'cli-ux'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import Netrc from 'netrc-parser'
import opn = require('opn')
import {hostname} from 'os'
import * as path from 'path'

import {APIClient, HerokuAPIError} from './api_client'
import {vars} from './vars'

const debug = require('debug')('heroku-cli-command')

export namespace Login {
  export interface Options {
    expiresIn?: number
    method?: 'interactive' | 'sso' | 'browser'
    browser?: string
  }
}

interface NetrcEntry {
  login: string
  password: string
}

const headers = (token: string) => ({headers: {accept: 'application/vnd.heroku+json; version=3', authorization: `Bearer ${token}`}})

export class Login {
  loginHost = process.env.HEROKU_LOGIN_HOST || 'https://cli-login.heroku.com'
  settings!: {
    method?: string
    org?: string
  }

  constructor(private readonly config: Config.IConfig, private readonly heroku: APIClient) {}

  async login(opts: Login.Options = {}): Promise<void> {
    await this.loadSettings()
    let loggedIn = false
    try {
      // timeout after 10 minutes
      setTimeout(() => {
        if (!loggedIn) ux.error('timed out')
      }, 1000 * 60 * 10).unref()

      if (process.env.HEROKU_API_KEY) ux.error('Cannot log in with HEROKU_API_KEY set')
      await Netrc.load()
      const previousEntry = Netrc.machines['api.heroku.com']
      let input: string | undefined = opts.method
      const defaultMethod = this.settings.method || 'interactive'
      if (!input) {
        if (opts.expiresIn) {
          // can't use browser with --expires-in
          input = 'interactive'
        } else if (this.enableBrowserLogin()) {
          input = await ux.prompt(`heroku: Login with [${color.green('b')}]rowser, [${color.green('i')}]nteractive, or [${color.green('s')}]so (enterprise-only)`, {default: defaultMethod})
        } else {
          input = defaultMethod || 'interactive'
        }
      }
      try {
        if (previousEntry && previousEntry.password) await this.logout(previousEntry.password)
      } catch (err) {
        ux.warn(err)
      }
      let auth
      delete this.settings.method
      switch (input) {
        case 'b':
        case 'browser':
          auth = await this.browser()
          break
        case 'i':
        case 'interactive':
          auth = await this.interactive(previousEntry && previousEntry.login, opts.expiresIn)
          break
        case 's':
        case 'sso':
          auth = await this.sso()
          break
        default:
          return this.login(opts)
      }
      await this.saveToken(auth)
      await this.saveSettings()
    } catch (err) {
      throw new HerokuAPIError(err)
    } finally {
      loggedIn = true
    }
  }

  async logout(token = this.heroku.auth) {
    if (!token) return debug('no credentials to logout')
    const requests: Promise<any>[] = []
    // for SSO logins we delete the session since those do not show up in
    // authorizations because they are created a trusted client
    requests.push(HTTP.delete(`${vars.apiUrl}/oauth/sessions/~`, headers(token))
    .catch(err => {
      if (!err.http) throw err
      if (err.http.statusCode === 404 && err.http.body && err.http.body.id === 'not_found' && err.http.body.resource === 'session') {
        return
      }
      if (err.http.statusCode === 401 && err.http.body && err.http.body.id === 'unauthorized') {
        return
      }
      throw err
    }))

    // grab all the authorizations so that we can delete the token they are
    // using in the CLI.  we have to do this rather than delete ~ because
    // the ~ is the API Key, not the authorization that is currently requesting
    requests.push(HTTP.get<Heroku.OAuthAuthorization[]>(`${vars.apiUrl}/oauth/authorizations`, headers(token))
    .then(async ({body: authorizations}) => {
      // grab the default authorization because that is the token shown in the
      // dashboard as API Key and they may be using it for something else and we
      // would unwittingly break an integration that they are depending on
      const d = await this.defaultToken()
      if (d === token) return
      return Promise.all(
        authorizations
        .filter(a => a.access_token && a.access_token.token === this.heroku.auth)
        .map(a => HTTP.delete(`${vars.apiUrl}/oauth/authorizations/${a.id}`, headers(token)))
      )
    })
    .catch(err => {
      if (!err.http) throw err
      if (err.http.statusCode === 401 && err.http.body && err.http.body.id === 'unauthorized') {
        return []
      }
      throw err
    }))

    await Promise.all(requests)
  }

  private async browser(): Promise<NetrcEntry> {
    const {body: urls} = await HTTP.post<{browser_url: string, cli_url: string, token: string}>(`${this.loginHost}/auth`)
    // TODO: handle browser
    const url = `${this.loginHost}${urls.browser_url}`
    debug(`opening browser to ${url}`)
    const cp = await opn(url, {wait: false})
    cp.on('error', ux.error)
    const showUrl = () => ux.warn(`Cannot open browser. Go to ${color.greenBright(url)} to finish login or run ${color.cmd('heroku login --interactive')}\n`)
    if (process.env.HEROKU_TESTING_HEADLESS_LOGIN === '1') showUrl()
    cp.on('close', code => {
      if (code !== 0) showUrl()
    })
    ux.action.start('Waiting for login')
    const {body: auth} = await HTTP.get<{error?: string, access_token: string}>(`${this.loginHost}${urls.cli_url}`, {
      headers: {
        authorization: `Bearer ${urls.token}`,
      }
    })
    if (auth.error) ux.error(auth.error)
    this.heroku.auth = auth.access_token
    ux.action.start('Logging in')
    const {body: account} = await HTTP.get<Heroku.Account>(`${vars.apiUrl}/account`, headers(auth.access_token))
    ux.action.stop()
    return {
      login: account.email!,
      password: auth.access_token,
    }
  }

  private async interactive(login?: string, expiresIn?: number): Promise<NetrcEntry> {
    process.stderr.write('heroku: Enter your login credentials\n')
    login = await ux.prompt('Email', {default: login})
    let password = await ux.prompt('Password', {type: 'hide'})

    let auth
    try {
      auth = await this.createOAuthToken(login!, password, {expiresIn})
    } catch (err) {
      if (!err.body || err.body.id !== 'two_factor') throw err
      let secondFactor = await ux.prompt('Two-factor code', {type: 'mask'})
      auth = await this.createOAuthToken(login!, password, {expiresIn, secondFactor})
    }
    this.heroku.auth = auth.password
    return auth
  }

  private async createOAuthToken(username: string, password: string, opts: {expiresIn?: number, secondFactor?: string} = {}): Promise<NetrcEntry> {
    function basicAuth(username: string, password: string) {
      let auth = [username, password].join(':')
      auth = Buffer.from(auth).toString('base64')
      return `Basic ${auth}`
    }

    let headers: {[k: string]: string} = {
      accept: 'application/vnd.heroku+json; version=3',
      authorization: basicAuth(username, password)
    }

    if (opts.secondFactor) headers['Heroku-Two-Factor-Code'] = opts.secondFactor

    const {body: auth} = await HTTP.post<Heroku.OAuthAuthorization>(`${vars.apiUrl}/oauth/authorizations`, {
      headers,
      body: {
        scope: ['global'],
        description: `Heroku CLI login from ${hostname()}`,
        expires_in: opts.expiresIn || 60 * 60 * 24 * 365 // 1 year
      }
    })
    return {password: auth.access_token!.token!, login: auth.user!.email!}
  }

  private async saveToken(entry: NetrcEntry) {
    const hosts = [vars.apiHost, vars.httpGitHost]
    hosts.forEach(host => {
      if (!Netrc.machines[host]) Netrc.machines[host] = {}
      Netrc.machines[host].login = entry.login
      Netrc.machines[host].password = entry.password
      delete Netrc.machines[host].method
      delete Netrc.machines[host].org
    })
    if (Netrc.machines._tokens) {
      (Netrc.machines._tokens as any).forEach((token: any) => {
        if (hosts.includes(token.host)) {
          token.internalWhitespace = '\n  '
        }
      })
    }
    await Netrc.save()
  }

  private async defaultToken(): Promise<string | undefined> {
    try {
      const {body: authorization} = await HTTP.get<Heroku.OAuthAuthorization>(`${vars.apiUrl}/oauth/authorizations/~`, headers(this.heroku.auth!))
      return authorization.access_token && authorization.access_token.token
    } catch (err) {
      if (!err.http) throw err
      if (err.http.statusCode === 404 && err.http.body && err.http.body.id === 'not_found' && err.body.resource === 'authorization') return
      if (err.http.statusCode === 401 && err.http.body && err.http.body.id === 'unauthorized') return
      throw err
    }
  }

  private enableBrowserLogin() {
    if (!process.env.HEROKU_LOGIN_HOST) return false
    if (this.config.name === '@heroku-cli/command') return true
    return this.config.channel !== 'stable'
  }

  private async sso(): Promise<NetrcEntry> {
    let url = process.env.SSO_URL
    let org = process.env.HEROKU_ORGANIZATION || this.settings.org
    if (!url) {
      if (org) {
        org = await ux.prompt('Organization name', {default: org})
      } else {
        org = await ux.prompt('Organization name')
      }
      url = `https://sso.heroku.com/saml/${encodeURIComponent(org!)}/init?cli=true`
    }

    ux.action.start('Opening browser for login')
    // TODO: handle browser
    debug(`opening browser to ${url}`)
    await opn(url, {wait: false})

    const password = await ux.prompt('Access token', {type: 'mask'})
    ux.action.start('Validating token')
    this.heroku.auth = password
    const {body: account} = await HTTP.get<Heroku.Account>(`${vars.apiUrl}/account`, headers(password))

    this.settings.method = 'sso'
    this.settings.org = org
    return {password, login: account.email!}
  }

  private async loadSettings() {
    try {
      this.settings = await fs.readJSON(this.settingsPath)
    } catch (err) {
      if (err.code !== 'ENOENT') ux.warn(err)
      else debug(err)
      this.settings = {}
    }
  }

  private async saveSettings() {
    try {
      if (Object.keys(this.settings).length === 0) {
        await fs.remove(this.settingsPath)
      } else {
        await fs.outputJSON(this.settingsPath, this.settings)
      }
    } catch (err) {
      ux.warn(err)
    }
  }

  private get settingsPath() { return path.join(this.config.dataDir, 'login.json') }
}
