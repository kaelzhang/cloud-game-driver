const {join} = require('node:path')
const fs = require('node:fs/promises')
const {
  log,
  Viewport
} = require('../../util')

const {
  BrowserWindow,
  app,
  ipcMain
} = require('electron')

const {
  UNDEFINED,
  NOOP
} = require('../../const')

const DOWNLOAD_PATH = join(__dirname, 'downloads')


class ElectronDelegate {
  constructor ({
    debug = false
  } = {}) {
    this._mainWindow = UNDEFINED
    this._debug = debug

    this._init()

    app.whenReady().then(() => {
      this._resolveReady()
      this._resolveReady = NOOP
    })

    app.on('activate', () => {
      this._resolveReady()
    })

    app.on('window-all-closed', function () {
      if (process.platform !== 'darwin') app.quit()
    })
  }

  _init () {
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve
    })
  }

  async launch ({
    url,
    width,
    height,
    userAgent
  }) {
    await this._readyPromise

    await this._createWindow({
      url,
      width,
      height,
      userAgent
    })
  }

  async _createWindow ({
    url,
    width,
    height,
    userAgent
  }) {
    const mainWindow = this._mainWindow = new BrowserWindow({
      width,
      height,
      resizable: false,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        // TODO:
        // We need this to make `require()` work in the preload script,
        // However, it's a security risk.
        // We should use a bundler to bundle the preload script instead of
        //   relying on `require()`.
        nodeIntegration: true
      }
    })

    if (this._debug) {
      // open devtools in exeternal window
      mainWindow.webContents.openDevTools({
        mode: 'undocked'
      })
    }

    this._createControlPanel()
    this._initIPCHandlers()

    let resolve

    const promise = new Promise((_resolve) => {
      resolve = _resolve
    })

    const {webContents} = mainWindow

    webContents.setUserAgent(userAgent)

    webContents.on('did-finish-load', () => {
      resolve()

      // Focus the window to make the click event work
      webContents.focus()
    })

    await mainWindow.loadURL(url)

    return promise
  }

  _createControlPanel () {
    const mainWindow = this._mainWindow
    const bounds = mainWindow.getBounds()

    this._controlPanel = new BrowserWindow({
      width: 200,
      height: 400,
      x: bounds.x + bounds.width,
      y: bounds.y,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    this._controlPanel.loadFile(join(__dirname, 'control-panel.html'))
  }

  // Add IPC handlers
  _initIPCHandlers () {
    // Sent from the control panel
    // ------------------------------------------------------------
    ipcMain.on('start-capture-mode', () => {
      log('received "start-capture-mode" from control panel')

      const {webContents} = this._mainWindow
      webContents.focus()
      webContents.send('capture-mode-change', true)
    })

    ipcMain.on('stop-capture-mode', () => {
      log('received "stop-capture-mode" from control panel')
      this._mainWindow.webContents.send('capture-mode-change', false)
    })

    ipcMain.on('start-pixel-picker-mode', () => {
      log('received "start-pixel-picker-mode" from control panel')

      const {webContents} = this._mainWindow
      webContents.focus()
      webContents.send('pixel-picker-mode-change', true)
    })

    ipcMain.on('stop-pixel-picker-mode', () => {
      log('received "stop-pixel-picker-mode" from control panel')
      this._mainWindow.webContents.send('pixel-picker-mode-change', false)
    })

    // Sent from the main window
    // ------------------------------------------------------------
    ipcMain.on('capture-region', async (event, bounds) => {
      log('received "capture-region" from main window')
      try {
        const result = await this._captureRegion(bounds)
        event.reply('capture-complete', result)
      } catch (error) {
        event.reply('capture-error', error.message)
      }
    })

    ipcMain.on('get-pixel', async (event, position) => {
      log('received "get-pixel" from main window')
      try {
        const pixel = await this._getPixel(position.x, position.y)
        this._controlPanel.webContents.send('pixel-update', pixel)
      } catch (error) {
        console.error('Color picking failed:', error)
      }
    })
  }

  async click (x, y) {
    const {webContents} = this._mainWindow

    webContents.sendInputEvent({
      type: 'mouseDown',
      x,
      y
    })

    webContents.sendInputEvent({
      type: 'mouseUp',
      x,
      y
    })
  }

  async screenshot (viewport) {
    const mainWindow = this._mainWindow
    const {webContents} = mainWindow

    if (!viewport) {
      viewport = mainWindow.getBounds()
    }

    return webContents.capturePage(viewport)
  }

  async _captureRegion(viewport) {
    const image = await this.screenshot(viewport)
    const buffer = image.toPNG()

    const bounds = viewport.object()

    log('writing capture image to', DOWNLOAD_PATH, bounds)

    const imagePath = await this._save(buffer)
    const jsonPath = await this._save(bounds)

    return {
      imagePath,
      jsonPath,
      viewport: bounds
    }
  }

  async _save (data, namePrefix = 'capture') {
    const name = `${namePrefix}_${Date.now()}`

    let filepath
    let content

    if (Buffer.isBuffer(data)) {
      filepath = join(DOWNLOAD_PATH, `${name}.png`)
      await fs.writeFile(filepath, data)
    } else {
      filepath = join(DOWNLOAD_PATH, `${name}.json`)
      await fs.writeFile(filepath, JSON.stringify(data))
    }

    return filepath
  }

  async _getPixel(x, y) {
    const image = await this.screenshot(new Viewport(x, y, 1, 1))
    const buffer = image.toBitmap()
    const rgb = {
      r: buffer[2],
      g: buffer[1],
      b: buffer[0]
    }

    const data = {
      x,
      y,
      rgb
    }

    await this._save(data, 'pixel')

    return data
  }
}


module.exports = {
  ElectronDelegate
}
