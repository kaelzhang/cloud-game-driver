const {Jimp} = require('jimp')
const {ssim} = require('ssim.js')

const {
  Action,
  IntervalPerformer
} = require('./action')

const {
  log
} = require('../util')

class ImageMatcher extends Action {
  static Performer = IntervalPerformer

  constructor (
    viewport,
    // The target image buffer to match, could be either
    // - a string path to the image file
    // - a Jimp instance
    to, {
      similarity = 0.9
    } = {}
  ) {
    super()
    this._viewport = viewport
    this._to = to

    const {
      promise,
      resolve
    } = Promise.withResolvers()

    this._toPromise = promise
    this._toResolve = resolve
    this._toChecked = false

    this._similarity = similarity
  }

  async _checkTo () {
    if (this._toChecked) {
      return this._toPromise
    }

    this._toChecked = true

    let to

    if (typeof this._to === 'string') {
      to = await Jimp.read(this._to)
    } else {
      to = this._to
    }

    this._toResolve(to)
    return to
  }

  async _perform (game) {
    const [viewport, to] = await Promise.all([
      game.screenshot(this._viewport),
      this._checkTo()
    ])

    // Compare the similarity between `viewport` and `this._to`,
    const similarity = this._compare(viewport.bitmap, to.bitmap)

    log('similarity', this._viewport.object(), similarity)

    return similarity >= this._similarity
  }

  _compare (from, to) {
    const {mssim} = ssim(from, to)
    return mssim
  }
}

module.exports = {
  ImageMatcher
}
