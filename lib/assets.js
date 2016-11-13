var Promise = require('bluebird')
var asyncReplace = Promise.promisify(require('async-replace'))
var fs = require('fs')
var FS = Promise.promisifyAll(fs)
var path = require('path')
var shortid = require('shortid')
var minimatch = require('minimatch')
var url = require('url')
var jsStringEscape = require('js-string-escape')

var test = /{#asset ([^{}]{0,150})}/g

function evaluateAssets (reporter, stringToReplace, req) {
  req.evaluateAssetsCounter = req.evaluateAssetsCounter || 0
  req.evaluateAssetsCounter++

  var replacedAssets = []

  function convert (str, p1, offset, s, done) {
    var assetName = (p1.indexOf(' @') !== -1) ? p1.substring(0, p1.indexOf(' @')) : p1

    var encoding = 'utf8'
    if (p1.indexOf(' @') !== -1) {
      var paramRaw = p1.replace(assetName, '').replace(' @', '')

      if (paramRaw.split('=').length !== 2) {
        throw new Error('Wrong asset param specification, should be {#asset name @encoding=base64}')
      }

      var paramName = paramRaw.split('=')[0]
      var paramValue = paramRaw.split('=')[1]

      if (paramName !== 'encoding') {
        throw new Error('Unsupported param ' + paramName)
      }

      if (paramValue !== 'base64' && paramValue !== 'utf8' && paramValue !== 'string' && paramValue !== 'link') {
        throw new Error('Unsupported asset encoding param value ' + paramValue + ', supported values are base64, utf8 and string')
      }

      encoding = paramValue
    }

    readAsset(reporter, assetName, encoding, req).then(function (content) {
      replacedAssets.push(assetName)
      done(null, content)
    }).catch(done)
  }

  return asyncReplace(stringToReplace, test, convert).then(function (result) {
    req.logger.debug('Replaced assets ' + JSON.stringify(replacedAssets))

    if (test.test(result) && req.evaluateAssetsCounter < 100) {
      return evaluateAssets(reporter, result, req)
    }

    return result
  })
}

function linkPath (reporter, link) {
  var result = path.isAbsolute(link) ? link : path.join(reporter.options.rootDirectory, link)

  if (!reporter.options.assets.allowedFiles ||
    (!minimatch(result, reporter.options.assets.allowedFiles) && minimatch(result.replace('/', '\\'), reporter.options.assets.allowedFiles)) ||
    (!minimatch(link, reporter.options.assets.allowedFiles) && minimatch(link.replace('/', '\\'), reporter.options.assets.allowedFiles))) {
    var err = new Error('Request to file ' + result + ' denied. Please allow it by setting config { "assets": { "allowedFiles": "**/foo.js" } }')
    err.weak = true
    throw err
  }

  return result
}

function readFile (reporter, link) {
  const pathToLinkedFile = linkPath(reporter, link)

  return FS.readFileAsync(pathToLinkedFile).then(function (content) {
    return content
  }).catch(function () {
    var err = new Error('Unable to find file ' + pathToLinkedFile)
    err.weak = true
    throw err
  })
}

function resolveAssetLink (reporter, req, assetName) {
  if (reporter.options.assets.rootUrlForLinks) {
    return url.resolve(reporter.options.assets.rootUrlForLinks, 'assets/' + assetName)
  }

  if (!req.url) {
    var protocol = reporter.options.httpPort ? 'http://' : 'https://'
    var port = reporter.options.httpPort || reporter.options.httpsPort
    return url.resolve(protocol + 'localhost:' + port, 'assets/' + assetName)
  }

  var base = req.protocol + '://' + req.get('host')
  return base + (req.originalUrl || '/').replace('api/report', '') + '/assets' + assetName
}

function readAsset (reporter, name, encoding, req) {
  if (encoding === 'link') {
    return Promise.resolve(resolveAssetLink(reporter, req, name))
  }

  var escape = function (val) { return val }

  if (encoding === 'string') {
    escape = jsStringEscape
    encoding = 'utf8'
  }

  return reporter.documentStore.collection('assets').find({ name: name }, reporter.options.assets.publicAccessEnabled ? null : req).then(function (result) {
    if (result.length < 1) {
      if (reporter.options.assets.searchOnDiskIfNotFoundInStore !== true) {
        throw new Error('Asset ' + name + ' not found')
      }

      return readFile(reporter, name).then(function (content) {
        return escape(new Buffer(content).toString(encoding))
      })
    }

    if (result[0].link) {
      return readFile(reporter, result[0].link).then(function (content) {
        return escape(new Buffer(content).toString(encoding))
      })
    }

    return escape(new Buffer(result[0].content).toString(encoding))
  })
}

module.exports = function (reporter, definition) {
  reporter.documentStore.registerEntityType('AssetType', {
    _id: { type: 'Edm.String', key: true },
    name: { type: 'Edm.String', key: true, publicKey: true },
    shortid: { type: 'Edm.String' },
    content: { type: 'Edm.Binary', document: { extension: 'html', content: true } },
    link: { type: 'Edm.String' }
  })

  reporter.documentStore.registerEntitySet('assets', {
    entityType: 'jsreport.AssetType',
    splitIntoDirectories: true
  })

  reporter.options.assets = reporter.options.assets || definition.options

  reporter.on('express-configure', function (app) {
    app.enable('trust proxy')

    app.get('/assets/:name', function (req, res) {
      readAsset(reporter, req.params.name, 'binary', req).then(function (content) {
        res.setHeader('Content-Disposition', 'attachment;filename=' + req.params.name)
        res.end(content, 'binary')
      }).catch(function (e) {
        res.status(500).end(e.message)
      })
    })

    app.get('/assets/link/:link', function (req, res) {
      try {
        res.send(linkPath(reporter, req.params.link))
      } catch (e) {
        res.status(500).end(e.message)
      }
    })
  })

  reporter.beforeRenderListeners.insert({ after: 'scripts' }, definition.name, this, function (req, res) {
    return evaluateAssets(reporter, req.template.content, req).then(function (result) {
      req.template.content = result

      if (req.template.helpers && typeof req.template.helpers === 'string') {
        return evaluateAssets(reporter, req.template.helpers, req).then(function (result) {
          req.template.helpers = result
        })
      }
    })
  })

  reporter.afterTemplatingEnginesExecutedListeners.add('assets', function (req, res) {
    return evaluateAssets(reporter, res.content.toString(), req).then(function (result) {
      res.content = new Buffer(result)
    })
  })

  reporter.initializeListeners.add('assets', function () {
    if (reporter.options.assets.publicAccessEnabled) {
      reporter.emit('export-public-route', '/assets')
    }

    reporter.documentStore.addFileExtensionResolver(function (doc, entitySetName, entityType, propertyType) {
      if (entitySetName === 'assets' && propertyType.document.content) {
        var extensions = path.extname(doc.name).split('.')
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

    reporter.documentStore.collection('assets').beforeInsertListeners.add('assets', function (entity) {
      if (!entity.shortid) {
        entity.shortid = shortid.generate()
      }

      if (entity.link) {
        entity.name = path.basename(entity.link)
        return readFile(reporter, entity.link).then(function () {
          return entity
        })
      }
    })

    reporter.documentStore.collection('assets').beforeUpdateListeners.add('assets', function (query, update) {
      if (query._id && update.$set && update.$set.content && update.$set.link) {
        return FS.writeFileAsync(linkPath(reporter, update.$set.link), update.$set.content).then(function () {
          delete update.$set.content
        }).catch(function (e) {
          var error = new Error('Unable to access file ' + linkPath(reporter, update.$set.link))
          error.weak = true
          throw error
        })
      }
    })
  })
}
