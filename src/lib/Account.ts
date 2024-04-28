import AdapterFactory from './AdapterFactory'
import Logger from './Logger'
import { Folder, ItemLocation, TItemLocation } from './Tree'
import UnidirectionalSyncProcess from './strategies/Unidirectional'
import MergeSyncProcess from './strategies/Merge'
import DefaultSyncProcess from './strategies/Default'
import IAccountStorage, { IAccountData, TAccountStrategy } from './interfaces/AccountStorage'
import { TAdapter } from './interfaces/Adapter'
import { OrderFolderResource, TLocalTree } from './interfaces/Resource'
import { Capacitor } from '@capacitor/core'
import IAccount from './interfaces/Account'
import Mappings from './Mappings'
import { isTest } from './isTest'
import CachingAdapter from './adapters/Caching'

// register Adapters
AdapterFactory.register('nextcloud-folders', async() => (await import('./adapters/NextcloudBookmarks')).default)
AdapterFactory.register('nextcloud-bookmarks', async() => (await import('./adapters/NextcloudBookmarks')).default)
AdapterFactory.register('webdav', async() => (await import('./adapters/WebDav')).default)
AdapterFactory.register('google-drive', async() => (await import('./adapters/GoogleDrive')).default)
AdapterFactory.register('fake', async() => (await import('./adapters/Fake')).default)

// 2h
const LOCK_TIMEOUT = 1000 * 60 * 60 * 2

export default class Account {
  static cache = {}
  static singleton : IAccount

  static async getAccountClass(): Promise<IAccount> {
    if (this.singleton) {
      return this.singleton
    }
    if (Capacitor.getPlatform() === 'web') {
      this.singleton = (await import('./browser/BrowserAccount')).default
    } else {
      this.singleton = (await import('./native/NativeAccount')).default
    }
    return this.singleton
  }

  static async get(id:string):Promise<Account> {
    if (this.cache[id]) {
      await this.cache[id].updateFromStorage()
      return this.cache[id]
    }
    const account = await (await this.getAccountClass()).get(id)
    this.cache[id] = account
    return account
  }

  static async create(data: IAccountData):Promise<Account> {
    return (await this.getAccountClass()).create(data)
  }

  static async import(accounts:IAccountData[]):Promise<void> {
    for (const accountData of accounts) {
      await this.create({...accountData, enabled: false})
    }
  }

  static async export(accountIds:string[]):Promise<IAccountData[]> {
    return (await Promise.all(
      accountIds.map(id => Account.get(id))
    )).map(a => a.getData())
  }

  public id: string
  public syncing: boolean
  protected syncProcess: DefaultSyncProcess
  protected storage: IAccountStorage
  protected server: TAdapter
  protected localTree: TLocalTree
  protected localTabs: TLocalTree

  constructor(id:string, storageAdapter:IAccountStorage, serverAdapter: TAdapter, treeAdapter:TLocalTree) {
    this.server = serverAdapter
    this.id = id
    this.storage = storageAdapter
    this.localTree = treeAdapter
  }

  async delete():Promise<void> {
    await this.storage.deleteAccountData()
  }

  getLabel():string {
    return this.server.getLabel()
  }

  getData():IAccountData {
    const defaults = {
      localRoot: null,
      strategy: 'default' as TAccountStrategy,
      syncInterval: 15,
      nestedSync: false,
      failsafe: true,
      allowNetwork: false,
    }
    const data = Object.assign(defaults, this.server.getData())
    if (data.type === 'nextcloud-folders') {
      data.type = 'nextcloud-bookmarks'
    }
    return data
  }

  async getResource():Promise<OrderFolderResource> {
    return this.localTree
  }

  async setData(data:IAccountData):Promise<void> {
    await this.storage.setAccountData(data, null)
    this.server.setData(data)
  }

  async updateFromStorage():Promise<void> {
    throw new Error('Not implemented')
  }

  async tracksBookmark(localId:string):Promise<boolean> {
    if (!(await this.isInitialized())) return false
    const mappings = await this.storage.getMappings()
    const snapshot = mappings.getSnapshot()
    const foundBookmark = Object.keys(snapshot.LocalToServer.bookmark).some(
      (id) => String(localId) === String(id)
    )
    const foundFolder = Object.keys(snapshot.LocalToServer.folder).some(
      (id) => String(localId) === String(id)
    )
    return foundBookmark || foundFolder
  }

  async init():Promise<void> {
    throw new Error('Not implemented')
  }

  async isInitialized():Promise<boolean> {
    throw new Error('Not implemented')
  }

  async sync(strategy?:TAccountStrategy):Promise<void> {
    let mappings: Mappings
    try {
      if (this.getData().syncing || this.syncing) return

      Logger.log('Starting sync process for account ' + this.getLabel())
      this.syncing = true
      await this.setData({ ...this.getData(), syncing: 0.05, scheduled: false, error: null })

      if (!(await this.isInitialized())) {
        await this.init()
      }

      const localResource = await this.getResource()

      if (this.server.onSyncStart) {
        const needLock = (strategy || this.getData().strategy) !== 'slave'
        let status
        try {
          status = await this.server.onSyncStart(needLock)
        } catch (e) {
          // Resource locked
          if (e.code === 37) {
            // We got a resource locked error
            if (this.getData().lastSync < Date.now() - LOCK_TIMEOUT) {
              // but if we've been waiting for the lock for more than 2h
              // start again without locking the resource
              status = await this.server.onSyncStart(false)
            } else {
              await this.setData({
                ...this.getData(),
                error: null,
                syncing: false,
                scheduled: strategy || this.getData().strategy
              })
              this.syncing = false
              Logger.log(
                'Resource is locked, trying again soon'
              )
              await Logger.persist()
              return
            }
          } else {
            throw e
          }
        }
        if (status === false) {
          await this.init()
        }
      }

      // main sync steps:
      mappings = await this.storage.getMappings()
      const cacheTree = localResource.constructor.name !== 'LocalTabs' ? await this.storage.getCache() : new Folder({title: '', id: 'tabs', location: ItemLocation.LOCAL})

      let continuation = await this.storage.getCurrentContinuation()

      if (typeof continuation !== 'undefined' && continuation !== null) {
        try {
          this.syncProcess = await DefaultSyncProcess.fromJSON(
            mappings,
            localResource,
            this.server,
            async (progress) => {
              if (!this.syncing) {
                return
              }
              if (!(this.server instanceof CachingAdapter) || !('onSyncComplete' in this.server)) {
                await this.storage.setCurrentContinuation(this.syncProcess.toJSON())
              }
              await this.setData({ ...this.getData(), syncing: progress })
              await mappings.persist()
            },
            continuation
          )
        } catch (e) {
          continuation = null
          Logger.log('Failed to load pending continuation. Continuing with normal sync')
        }
      }

      if (typeof continuation === 'undefined' || continuation === null || (typeof strategy !== 'undefined' && continuation.strategy !== strategy) || Date.now() - continuation.createdAt > 1000 * 60 * 30) {
        // If there is no pending continuation, we just sync normally
        // Same if the pending continuation was overridden by a different strategy
        // same if the continuation is older than half an hour. We don't want old zombie continuations

        let strategyClass: typeof DefaultSyncProcess|typeof MergeSyncProcess|typeof UnidirectionalSyncProcess, direction: TItemLocation
        switch (strategy || this.getData().strategy) {
          case 'slave':
            Logger.log('Using "merge slave" strategy (no cache available)')
            strategyClass = UnidirectionalSyncProcess
            direction = ItemLocation.LOCAL
            break
          case 'overwrite':
            Logger.log('Using "merge overwrite" strategy (no cache available)')
            strategyClass = UnidirectionalSyncProcess
            direction = ItemLocation.SERVER
            break
          default:
            if (!cacheTree.children.length) {
              Logger.log('Using "merge default" strategy (no cache available)')
              strategyClass = MergeSyncProcess
            } else {
              Logger.log('Using "default" strategy')
              strategyClass = DefaultSyncProcess
            }
            break
        }

        this.syncProcess = new strategyClass(
          mappings,
          localResource,
          this.server,
          async(progress, actionsDone?) => {
            await this.setData({ ...this.getData(), syncing: progress })
            if (actionsDone) {
              await this.storage.setCurrentContinuation(this.syncProcess.toJSON())
            }
            await mappings.persist()
          }
        )
        this.syncProcess.setCacheTree(cacheTree)
        if (direction) {
          this.syncProcess.setDirection(direction)
        }
        await this.syncProcess.sync()
      } else {
        // if there is a pending continuation, we resume it

        Logger.log('Found existing persisted pending continuation. Resuming last sync')
        await this.syncProcess.resumeSync()
      }

      await this.setData({ ...this.getData(), scheduled: false, syncing: 1 })

      // update cache
      if (localResource.constructor.name !== 'LocalTabs') {
        const cache = (await localResource.getBookmarksTree()).clone(false)
        this.syncProcess.filterOutUnacceptedBookmarks(cache)
        this.syncProcess.filterOutUnmappedItems(cache, await mappings.getSnapshot())
        await this.storage.setCache(cache)
      }

      if (this.server.onSyncComplete) {
        await this.server.onSyncComplete()
      }

      if (mappings) {
        await mappings.persist()
      }

      this.syncing = false

      await this.storage.setCurrentContinuation(null)
      await this.setData({
        ...this.getData(),
        error: null,
        syncing: false,
        scheduled: false,
        lastSync: Date.now(),
      })

      Logger.log(
        'Successfully ended sync process for account ' + this.getLabel()
      )
    } catch (e) {
      console.log(e)
      const message = await Account.stringifyError(e)
      console.error('Syncing failed with', message)
      Logger.log('Syncing failed with', message)

      await this.setData({
        ...this.getData(),
        error: message,
        syncing: false,
        scheduled: false,
      })
      if (matchAllErrors(e, e => e.code !== 27 && (!isTest || e.code !== 26))) {
        await this.storage.setCurrentContinuation(null)
      }
      this.syncing = false
      if (this.server.onSyncFail) {
        await this.server.onSyncFail()
      }

      // reset cache and mappings after error
      // (but not after interruption or NetworkError)
      if (matchAllErrors(e, e => e.code !== 27 && e.code !== 17  && (!isTest || e.code !== 26))) {
        await this.init()
      }
    }
    await Logger.persist()
  }

  static async stringifyError(er:any):Promise<string> {
    return (await this.getAccountClass()).stringifyError(er)
  }

  async cancelSync():Promise<void> {
    if (!this.syncing) return
    this.server.cancel()
    if (this.syncProcess) {
      await this.syncProcess.cancel()
    }
  }

  static async getAllAccounts():Promise<Account[]> {
    return (await this.getAccountClass()).getAllAccounts()
  }

  static async getAccountsContainingLocalId(localId:string, ancestors:string[], allAccounts:Account[]):Promise<Account[]> {
    return (await this.getAccountClass()).getAccountsContainingLocalId(localId, ancestors, allAccounts)
  }
}

function matchAllErrors(e, fn:(e)=>boolean) {
  return fn(e) && e.list && e.list.every(e => matchAllErrors(e, fn))
}
