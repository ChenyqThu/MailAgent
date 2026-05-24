// Sprint 19 §B eval harness — electron/keytar stub.
//
// Hooked via `node --import` (tsx then runs through this loader chain) so
// imports of 'electron' / 'keytar' resolve to no-op shapes. We never call
// any electron API in eval mode; the chat tool handlers reach into
// `handlers/email.ts` etc. only because of top-level `import { ipcMain }
// from 'electron'`. ipcMain itself is unused in tool dispatch paths —
// only `registerEmailHandlers()` consumers need it, and we never call those.

const Module = require('module')
const origLoad = Module._load

const electronStub = {
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
    emit: () => {}
  },
  app: {
    getPath: (name) => {
      if (name === 'userData') return '/tmp/eval-electron-userdata'
      if (name === 'downloads') return require('os').homedir() + '/Downloads'
      if (name === 'home') return require('os').homedir()
      return '/tmp/eval-electron-' + name
    },
    whenReady: () => Promise.resolve(),
    on: () => {}
  },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return null }
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' }
}

const keytarStub = {
  getPassword: async () => null,
  setPassword: async () => {},
  deletePassword: async () => false
}

Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (request === 'keytar') return keytarStub
  return origLoad.call(this, request, parent, isMain)
}
