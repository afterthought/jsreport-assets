const Promise = require('bluebird')
const asyncReplace = Promise.promisify(require('async-replace'))
const fs = require('fs')
const FS = Promise.promisifyAll(fs)
const path = require('path')
const nanoid = require('nanoid')
const minimatch = require('minimatch')
const url = require('url')
const jsStringEscape = require('js-string-escape')
const etag = require('etag')
const mime = require('mime')
const stripBom = require('strip-bom-buf')

const test = /{#asset ([^{}]{0,150})}/g
const imageTest = /\.(jpeg|jpg|gif|png|svg)$/
const fontTest = /\.(woff|ttf|otf|eot|woff2)$/

function isImage (name) {
  return name.match(imageTest) != null
}
function isFont (name) {
  return name.match(fontTest) != null
}

async function evaluateAssets (reporter, stringToReplace, req) {
  req.context.evaluateAssetsCounter = req.context.evaluateAssetsCounter || 0
  req.context.evaluateAssetsCounter++

  const replacedAssets = []

  function convert (str, p1, offset, s, done) {
    const assetName = (p1.indexOf(' @') !== -1) ? p1.substring(0, p1.indexOf(' @')) : p1

    let encoding = 'utf8'
    if (p1.indexOf(' @') !== -1) {
      const paramRaw = p1.replace(assetName, '').replace(' @', '')

      if (paramRaw.split('=').length !== 2) {
        throw new Error('Wrong asset param specification, should be {#asset name @encoding=base64}')
      }

      const paramName = paramRaw.split('=')[0]
      const paramValue = paramRaw.split('=')[1]

      if (paramName !== 'encoding') {
        throw new Error('Unsupported param ' + paramName)
      }

      if (paramValue !== 'base64' && paramValue !== 'utf8' && paramValue !== 'string' && paramValue !== 'link' && paramValue !== 'dataURI') {
        throw new Error('Unsupported asset encoding param value ' + paramValue + ', supported values are base64, utf8, link, dataURI and string')
      }

      if (paramValue === 'dataURI' && !isImage(assetName) && !isFont(assetName)) {
        throw new Error('Asset encoded as dataURI needs to have file extension jpeg|jpg|gif|png|svg|woff|tff|otf|woff2|eot')
      }

      encoding = paramValue
    }

    readAsset(reporter, assetName, encoding, req).then(function (res) {
      replacedAssets.push(assetName)
      done(null, res.content)
    }).catch(done)
  }

  const result = await asyncReplace(stringToReplace, test, convert)
  if (replacedAssets.length) {
    reporter.logger.debug('Replaced assets ' + JSON.stringify(replacedAssets), req)
  }

  if (test.test(result) && req.context.evaluateAssetsCounter < 100) {
    return evaluateAssets(reporter, result, req)
  }

  return result
}

function isAssetPathValid (allowedFiles, link, absolutePath) {
  return (allowedFiles != null) && (minimatch(absolutePath, allowedFiles) || minimatch(absolutePath.replace('/', '\\'), allowedFiles) ||
    minimatch(link, allowedFiles) || minimatch(link.replace('/', '\\'), allowedFiles))
}

function linkPath (reporter, link) {
  const result = path.isAbsolute(link) ? link : path.join(reporter.options.rootDirectory, link)

  if (!isAssetPathValid(reporter.options.assets.allowedFiles, link, result)) {
    const err = new Error('Request to file ' + result + ' denied. Please allow it by setting config { "assets": { "allowedFiles": "**/foo.js" } }')
    err.weak = true
    throw err
  }

  return result
}

async function readFile (reporter, link) {
  const pathToLinkedFile = linkPath(reporter, link)
  try {
    const content = await FS.readFileAsync(pathToLinkedFile)
    const stat = await FS.statAsync(pathToLinkedFile)
    return {
      content: stripBom(content),
      filename: path.basename(pathToLinkedFile),
      modified: stat.mtime
    }
  } catch (e) {
    const err = new Error('Unable to find file ' + pathToLinkedFile)
    err.weak = true
    throw err
  }
}

function resolveAssetLink (reporter, req, assetName) {
  if (reporter.options.assets.rootUrlForLinks) {
    return url.resolve(reporter.options.assets.rootUrlForLinks, 'assets/content/' + assetName)
  }

  if (!reporter.express) {
    return 'assets/content/' + assetName
  }

  const baseUrl = req.context.http ? req.context.http.baseUrl : reporter.express.localhostUrl

  return baseUrl + '/assets/content/' + assetName
}

async function readAsset (reporter, name, encoding, req) {
  let escape = function (val) { return val }

  if (encoding === 'string') {
    escape = jsStringEscape
    encoding = 'utf8'
  }

  if (encoding === 'dataURI') {
    escape = function (val, name) {
      const type = mime.getType(name)
      const charset = type.startsWith('text') ? 'UTF-8' : null
      return 'data:' + type + (charset ? '; charset=' + charset : '') + ';base64,' + val
    }
    encoding = 'base64'
  }

  const assets = await reporter.documentStore.collection('assets').find({$or: [{ name: name }, { link: name }]}, reporter.options.assets.publicAccessEnabled ? null : req)
  if (assets.length < 1) {
    if (reporter.options.assets.searchOnDiskIfNotFoundInStore !== true) {
      throw new Error('Asset ' + name + ' not found')
    }

    if (encoding === 'link') {
      return {
        content: resolveAssetLink(reporter, req, name),
        filename: name
      }
    }

    const file = await readFile(reporter, name)
    return {
      content: escape(Buffer.from(file.content || '').toString(encoding), file.filename),
      filename: file.filename,
      modified: file.modified
    }
  }

  if (encoding === 'link') {
    return assets[0].link ? {
      content: resolveAssetLink(reporter, req, assets[0].link),
      filename: name
    } : {
      content: resolveAssetLink(reporter, req, name),
      filename: name
    }
  }

  if (assets[0].link) {
    const file = await readFile(reporter, assets[0].link)
    return {
      content: escape(Buffer.from(file.content).toString(encoding), file.filename),
      filename: file.filename,
      modified: file.modified
    }
  }

  return {
    content: escape(Buffer.from(assets[0].content || '').toString(encoding), assets[0].name),
    filename: assets[0].name,
    modified: assets[0].modificationDate || new Date()
  }
}

module.exports = function (reporter, definition) {
  reporter.documentStore.registerEntityType('AssetType', {
    _id: { type: 'Edm.String', key: true },
    name: { type: 'Edm.String', key: true, publicKey: true },
    shortid: { type: 'Edm.String' },
    modificationDate: { type: 'Edm.DateTimeOffset' },
    content: { type: 'Edm.Binary', document: { extension: 'html', content: true } },
    forceUpdate: { type: 'Edm.Boolean' },
    isSharedHelper: { type: 'Edm.Boolean' },
    link: { type: 'Edm.String' }
  })

  reporter.documentStore.registerEntitySet('assets', {
    entityType: 'jsreport.AssetType',
    splitIntoDirectories: true
  })

  reporter.options.assets = reporter.options.assets || definition.options

  reporter.on('express-configure', (app) => {
    app.get('/assets/content/:path*', (req, res) => {
      const assetLink = req.params.path + req.params['0']

      readAsset(reporter, assetLink, 'binary', req).then((asset) => {
        if (req.query.download === 'true') {
          res.setHeader('Content-Disposition', 'attachment;filename=' + asset.filename)
        }
        res.setHeader('ETag', etag(asset.content))
        res.setHeader('Cache-Control', 'public, max-age=0')
        res.setHeader('Last-Modified', asset.modified.toUTCString())

        const type = mime.getType(asset.filename)
        if (type) {
          const charset = type.startsWith('text') ? 'UTF-8' : null
          res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''))
        }
        res.end(asset.content, 'binary')
      }).catch(function (e) {
        reporter.logger.warn('Unable to get asset content ' + assetLink, e)
        res.status(500).end(e.message)
      })
    })

    app.get('/assets/link/:path*', (req, res) => {
      const assetLink = req.params.path + req.params['0']
      try {
        res.send(linkPath(reporter, assetLink))
      } catch (e) {
        reporter.logger.warn('Unable to get asset link ' + assetLink, e)
        res.status(500).end(e.message)
      }
    })
  })

  reporter.beforeRenderListeners.insert({ after: 'scripts' }, definition.name, this, async (req, res) => {
    const sharedHelpersAssets = await reporter.documentStore.collection('assets').find({ isSharedHelper: true }, req)
    if (sharedHelpersAssets.length > 0 && typeof req.template.helpers === 'object') {
      reporter.logger.warn('Cannot add shared helpers when passing helpers as object', req)
    } else {
      const assetContents = await Promise.map(sharedHelpersAssets, (a) => readAsset(reporter, a.name, 'utf8', req))
      req.template.helpers = req.template.helpers || ''
      assetContents.forEach((ac) => {
        if (req.template.helpers.indexOf(ac.content) === -1) {
          req.template.helpers += '\n' + ac.content
        }
      })
    }

    req.template.content = await evaluateAssets(reporter, req.template.content, req)

    if (req.template.helpers && typeof req.template.helpers === 'string') {
      req.template.helpers = await evaluateAssets(reporter, req.template.helpers, req)
    }
  })

  reporter.afterTemplatingEnginesExecutedListeners.add('assets', async (req, res) => {
    const result = await evaluateAssets(reporter, res.content.toString(), req)
    res.content = Buffer.from(result)
  })

  reporter.initializeListeners.add('assets', () => {
    if (reporter.options.assets.publicAccessEnabled) {
      reporter.emit('export-public-route', '/assets')
    }

    reporter.documentStore.addFileExtensionResolver(function (doc, entitySetName, entityType, propertyType) {
      if (entitySetName === 'assets' && propertyType.document.content) {
        const extensions = path.extname(doc.name).split('.')
        return extensions[extensions.length - 1]
      }
    })

    if (reporter.beforeScriptListeners) {
      reporter.beforeScriptListeners.add('assets', function (scriptDef, req) {
        return evaluateAssets(reporter, scriptDef.script, req).then(function (result) {
          scriptDef.script = result
        })
      })
    }

    reporter.documentStore.collection('assets').beforeInsertListeners.add('assets', async (entity) => {
      delete entity.forceUpdate
      entity.modificationDate = new Date()

      if (!entity.shortid) {
        entity.shortid = nanoid(7)
      }

      if (entity.link) {
        entity.name = path.basename(entity.link)
        await readFile(reporter, entity.link)
        return entity
      }
    })

    reporter.documentStore.collection('assets').beforeUpdateListeners.add('assets', async (query, update) => {
      update.$set.modificationDate = new Date()

      if (query._id && update.$set && update.$set.forceUpdate && update.$set.link) {
        try {
          await FS.writeFileAsync(linkPath(reporter, update.$set.link), update.$set.content)
          delete update.$set.forceUpdate
          delete update.$set.content
        } catch (e) {
          const error = new Error('Unable to access file ' + linkPath(reporter, update.$set.link))
          error.weak = true
          throw error
        }
      } else {
        delete update.$set.forceUpdate
      }
    })
  })
}

module.exports.isAssetPathValid = isAssetPathValid
