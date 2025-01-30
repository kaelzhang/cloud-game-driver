const {join} = require('node:path')
const fs = require('node:fs/promises')

const {
  log,
  Viewport,
  encodeNativeBMPImage
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

  async _increaseBatchId () {
    const filepath = join(DOWNLOAD_PATH, '.batch.json')

    let batchId

    try {
      const content = await fs.readFile(filepath, 'utf-8')
      batchId = JSON.parse(content.toString()).batchId || 0
    } catch (error) {
      batchId = 0
    }

    batchId ++

    await fs.writeFile(filepath, JSON.stringify({batchId}))

    this._batchId = batchId
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
        preload: join(__dirname, 'main-window.js'),
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

    const controlPanel = this._controlPanel = new BrowserWindow({
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

    controlPanel.loadFile(join(__dirname, 'control-panel.html'))

    if (this._debug) {
      // open devtools in exeternal window
      controlPanel.webContents.openDevTools({
        mode: 'undocked'
      })
    }
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
        const {x, y, width, height} = bounds
        await this._captureRegion(
          new Viewport(x, y, width, height)
        )
      } catch (error) {
        log('Capture error', error.message)
      }
    })

    ipcMain.on('get-pixel', async (event, {x, y, save = false}) => {
      if (save) {
        log('received "get-pixel" from main window')
      }

      try {
        await this._getPixel(x, y, save)
      } catch (error) {
        log('Color picking failed:', error)
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

  // Returns a Jimp image
  async screenshot (viewport) {
    const mainWindow = this._mainWindow

    if (!viewport) {
      viewport = mainWindow.getBounds()
    }

    const image = await mainWindow.webContents.capturePage(viewport)
    return encodeNativeBMPImage(image)
  }

  async _captureRegion(viewport) {
    const image = await this.screenshot(viewport)
    const bounds = viewport.object()

    log('writing capture image to', DOWNLOAD_PATH, bounds)

    await this._increaseBatchId()

    const jsonPath = await this._saveJson(bounds)
    const imagePath = this._getCaptureFileName('bmp')

    await image.write(imagePath)

    const result = {
      imagePath,
      jsonPath,
      viewport: bounds
    }

    this._controlPanel.webContents.send('capture-complete', result)

    return result
  }

  _getCaptureFileName (ext, namePrefix = 'capture') {
    return join(DOWNLOAD_PATH, `${namePrefix}_${this._batchId}.${ext}`)
  }

  // Save a buffer or a JSON object to a file
  async _saveJson (data, namePrefix = 'capture') {
    const filepath = this._getCaptureFileName('json', namePrefix)
    await fs.writeFile(filepath, JSON.stringify(data))

    return filepath
  }

  async _getPixel(x, y, save) {
    const {
      bitmap: {
        data
      }
    } = await this.screenshot(new Viewport(x, y, 1, 1))

    // The buffer of Jimp is in RGBA format
    const rgb = {
      r: data[0],
      g: data[1],
      b: data[2]
    }

    const pixel = {
      x,
      y,
      rgb
    }

    const {webContents} = this._controlPanel

    webContents.send('pixel-update', pixel)

    if (save) {
      await this._save(pixel, 'pixel')
      webContents.send('pixel-pick-complete', pixel)
    }

    return pixel
  }
}


module.exports = {
  ElectronDelegate
}
