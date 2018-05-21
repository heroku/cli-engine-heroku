import {flags} from '@oclif/command'
import * as Config from '@oclif/config'
import * as path from 'path'

import deps from './deps'
import {configRemote, getGitRemotes} from './git'

export const oneDay = 60 * 60 * 24

export const herokuGet = async (resource: string, ctx: { config: Config.IConfig }): Promise<string[]> => {
  const heroku = new deps.APIClient(ctx.config)
  let {body: resources} = await heroku.get(`/${resource}`)
  if (typeof resources === 'string') resources = JSON.parse(resources)
  return resources.map((a: any) => a.name).sort()
}

export const AppCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let apps = await herokuGet('apps', ctx)
    return apps
  },
}

export const AppAddonCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  cacheKey: async ctx => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_addons` : ''
  },
  options: async ctx => {
    let addons = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/addons`, ctx) : []
    return addons
  },
}

export const AppDynoCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  cacheKey: async ctx => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_dynos` : ''
  },
  options: async ctx => {
    let dynos = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/dynos`, ctx) : []
    return dynos
  },
}

export const BuildpackCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    return [
      'heroku/ruby',
      'heroku/nodejs',
      'heroku/clojure',
      'heroku/python',
      'heroku/java',
      'heroku/gradle',
      'heroku/scala',
      'heroku/php',
      'heroku/go',
    ]
  },
}

export const DynoSizeCompletion: flags.ICompletion = {
  cacheDuration: oneDay * 90,
  options: async ctx => {
    let sizes = await herokuGet('dyno-sizes', ctx)
    return sizes
  },
}

export const FileCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    let files = await deps.file.readdir(process.cwd())
    return files
  },
}

export const PipelineCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let pipelines = await herokuGet('pipelines', ctx)
    return pipelines
  },
}

export const ProcessTypeCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    let types: string[] = []
    let procfile = path.join(process.cwd(), 'Procfile')
    try {
      let buff = await deps.file.readFile(procfile)
      types = buff
        .toString()
        .split('\n')
        .map(s => {
          if (!s) return false
          let m = s.match(/^([A-Za-z0-9_-]+)/)
          return m ? m[0] : false
        })
        .filter(t => t) as string[]
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    return types
  },
}

export const RegionCompletion: flags.ICompletion = {
  cacheDuration: oneDay * 7,
  options: async ctx => {
    let regions = await herokuGet('regions', ctx)
    return regions
  },
}

export const RemoteCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    let remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  },
}

export const RoleCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    return ['admin', 'collaborator', 'member', 'owner']
  },
}

export const ScopeCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected']
  },
}

export const SpaceCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let spaces = await herokuGet('spaces', ctx)
    return spaces
  },
}

export const StackCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let stacks = await herokuGet('stacks', ctx)
    return stacks
  },
}

export const StageCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    return ['test', 'review', 'development', 'staging', 'production']
  },
}

export const TeamCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let teams = await herokuGet('teams', ctx)
    return teams
  },
}
