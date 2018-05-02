import * as Config from '@oclif/config'
import {CLIError} from '@oclif/errors'
import {HTTP, HTTPError, HTTPRequestOptions} from 'http-call'
import * as url from 'url'

import deps from './deps'
import {Mutex} from './mutex'
import {vars} from './vars'

export interface IOptions {
  required?: boolean
  preauth?: boolean
}

export interface IHerokuAPIErrorOptions {
  resource?: string
  app?: { id: string; name: string }
  id?: string
  message?: string
  url?: string
}

export class HerokuAPIError extends CLIError {
  http: HTTPError
  body: IHerokuAPIErrorOptions

  constructor(httpError: HTTPError) {
    let options: IHerokuAPIErrorOptions = httpError.body
    if (!options.message) throw httpError
    let info = []
    if (options.id) info.push(`Error ID: ${options.id}`)
    if (options.app && options.app.name) info.push(`App: ${options.app.name}`)
    if (options.url) info.push(`See ${options.url} for more information.`)
    if (info.length) super([options.message, ''].concat(info).join('\n'))
    else super(options.message)
    this.http = httpError
    this.body = options
  }
}

export class APIClient {
  preauthPromises: { [k: string]: Promise<HTTP> }
  http: typeof HTTP
  private _twoFactorMutex: Mutex<string> | undefined
  private _auth?: string

  constructor(protected config: Config.IConfig, public options: IOptions = {}) {
    this.config = config
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    this.options = options
    let apiUrl = url.URL ? new url.URL(vars.apiUrl) : url.parse(vars.apiUrl)
    let envHeaders = JSON.parse(process.env.HEROKU_HEADERS || '{}')
    this.preauthPromises = {}
    let auth = this.auth
    let self = this as any
    const opts = {
      host: apiUrl.host,
      headers: {
        accept: 'application/vnd.heroku+json; version=3',
        'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
        ...envHeaders,
      },
    }
    if (auth && !opts.headers.authorization) opts.headers.authorization = `Bearer ${auth}`
    this.http = class APIHTTPClient extends deps.HTTP.HTTP.create(opts) {
      static async twoFactorRetry(
        err: HTTPError,
        url: string,
        opts: HTTPRequestOptions = {},
        retries = 3,
      ): Promise<APIHTTPClient> {
        const app = err.body.app ? err.body.app.name : null
        if (!app || !options.preauth) {
          opts.headers = opts.headers || {}
          opts.headers['Heroku-Two-Factor-Code'] = await self.twoFactorPrompt()
          return this.request(url, opts, retries)
        } else {
          // if multiple requests are run in parallel for the same app, we should
          // only preauth for the first so save the fact we already preauthed
          if (!self.preauthPromises[app]) {
            self.preauthPromises[app] = self.twoFactorPrompt().then((factor: any) => self.preauth(app, factor))
          }

          await self.preauthPromises[app]
          return this.request(url, opts, retries)
        }
      }

      static async request(url: string, opts: HTTPRequestOptions = {}, retries = 3) {
        retries--
        try {
          return await super.request(url, opts)
        } catch (err) {
          if (!(err instanceof deps.HTTP.HTTPError)) throw err
          if (retries > 0) {
            if (err.http.statusCode === 403 && err.body.id === 'two_factor') {
              return this.twoFactorRetry(err, url, opts, retries)
            }
          }
          throw new HerokuAPIError(err)
        }
      }
    }
  }

  get twoFactorMutex(): Mutex<string> {
    if (!this._twoFactorMutex) {
      this._twoFactorMutex = new deps.Mutex()
    }
    return this._twoFactorMutex
  }

  get auth(): string | undefined {
    if (!this._auth) {
      if (process.env.HEROKU_API_TOKEN && !process.env.HEROKU_API_KEY) deps.cli.warn('HEROKU_API_TOKEN is set but you probably meant HEROKU_API_KEY')
      this._auth = process.env.HEROKU_API_KEY
      if (!this._auth) {
        deps.netrc.loadSync()
        this._auth = deps.netrc.machines[vars.apiHost] && deps.netrc.machines[vars.apiHost].password
      }
    }
    return this._auth
  }

  twoFactorPrompt() {
    deps.yubikey.enable()
    return this.twoFactorMutex.synchronize(async () => {
      try {
        let factor = await deps.cli.prompt('Two-factor code', {type: 'mask'})
        deps.yubikey.disable()
        return factor
      } catch (err) {
        deps.yubikey.disable()
        throw err
      }
    })
  }

  preauth(app: string, factor: string) {
    return this.put(`/apps/${app}/pre-authorizations`, {
      headers: {'Heroku-Two-Factor-Code': factor},
    })
  }
  get(url: string, options: HTTPRequestOptions = {}) {
    return this.http.get(url, options)
  }
  post(url: string, options: HTTPRequestOptions = {}) {
    return this.http.post(url, options)
  }
  put(url: string, options: HTTPRequestOptions = {}) {
    return this.http.put(url, options)
  }
  patch(url: string, options: HTTPRequestOptions = {}) {
    return this.http.patch(url, options)
  }
  delete(url: string, options: HTTPRequestOptions = {}) {
    return this.http.delete(url, options)
  }
  stream(url: string, options: HTTPRequestOptions = {}) {
    return this.http.stream(url, options)
  }
  request(url: string, options: HTTPRequestOptions = {}) {
    return this.http.request(url, options)
  }
  get defaults(): typeof HTTP.defaults {
    return this.http.defaults
  }
}
