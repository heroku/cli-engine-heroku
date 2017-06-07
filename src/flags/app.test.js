// @flow

import Base from '../command'
import {app, remote} from './app'

let mockGitRemotes = jest.fn()

jest.mock('../git', () => {
  return class {
    get remotes () { return mockGitRemotes() }
  }
})

beforeEach(() => {
  mockGitRemotes.mockReturnValue([])
})

describe('required', () => {
  class Command extends Base {
    static flags = {app: app({required: true}), remote: remote()}
  }

  test('has an app', async () => {
    const cmd = await Command.mock('--app', 'myapp')
    expect(cmd.flags.app).toEqual('myapp')
  })

  test('gets app from --remote flag', async () => {
    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    const cmd = await Command.mock('-r', 'staging')
    expect(cmd.flags.app).toEqual('myapp-staging')
  })

  test('errors if --remote not found', async () => {
    expect.assertions(1)
    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    try {
      let cmd = await Command.mock('-r', 'foo')
      cmd.out.log(cmd.flags.app)
    } catch (err) {
      expect(err.message).toEqual('remote foo not found in git remotes')
    }
  })

  test('errors with no app', async () => {
    expect.assertions(1)
    try {
      let cmd = await Command.mock()
      console.log(cmd.flags.app) // should not get here
    } catch (err) {
      expect(err.message).toContain('No app specified')
    }
  })

  test('errors with 2 git remotes', async () => {
    expect.assertions(1)
    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    try {
      let cmd = await Command.mock()
      console.log(cmd.flags.app) // should not get here
    } catch (err) {
      expect(err.message).toContain('Multiple apps in git remotes')
    }
  })

  test('gets app from git config', async () => {
    mockGitRemotes.mockReturnValueOnce([{name: 'heroku', url: 'https://git.heroku.com/myapp.git'}])
    const cmd = await Command.mock()
    expect(cmd.flags.app).toEqual('myapp')
  })
})

describe('optional', () => {
  class Command extends Base {
    static flags = {app: app(), remote: remote()}
  }

  test('works when git errors out', async () => {
    expect.assertions(1)
    mockGitRemotes.mockImplementationOnce(() => {
      throw new Error('whoa!')
    })
    const cmd = await Command.mock()
    expect(cmd.flags.app).toBeUndefined()
  })

  test('does not error when app is not specified', async () => {
    const cmd = await Command.mock()
    expect(cmd.flags.app).toBeUndefined()
  })
})
