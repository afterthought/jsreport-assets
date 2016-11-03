require('should')
var Reporter = require('jsreport-core')

describe('assets', function () {
  var reporter

  beforeEach(function () {
    reporter = Reporter()
      .use(require('jsreport-templates')())
      .use(require('jsreport-jsrender')())
      .use(require('jsreport-scripts')())
      .use(require('../')())

    return reporter.init()
  })

  it('should handle normal render request', function () {
    return reporter.render({
      template: {
        content: 'foo',
        recipe: 'html',
        engine: 'none'
      }
    }).then(function (res) {
      res.content.toString().should.be.eql('foo')
    })
  })

  it('should extract static asset', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'foo.html',
      content: 'hello'
    }).then(function () {
      return reporter.render({
        template: {
          content: '{#asset foo.html}',
          recipe: 'html',
          engine: 'none'
        }
      }).then(function (res) {
        res.content.toString().should.be.eql('hello')
      })
    })
  })

  it('should extract static asset as base64 when @encoding=base64', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'foo.html',
      content: 'hello'
    }).then(function () {
      return reporter.render({
        template: {
          content: '{#asset foo.html @encoding=base64}',
          recipe: 'html',
          engine: 'none'
        }
      }).then(function (res) {
        res.content.toString().should.be.eql(new Buffer('hello').toString('base64'))
      })
    })
  })

  it('should extract static asset with name dynamically constructed by templating engine', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'a.html',
      content: 'hello'
    }).then(function () {
      return reporter.render({
        template: {
          content: '{#asset {{:~foo()}}}',
          recipe: 'html',
          helpers: 'function foo() { return "a.html" }',
          engine: 'jsrender'
        }
      }).then(function (res) {
        res.content.toString().should.be.eql('hello')
      })
    })
  })

  it('should extract assets recursively', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'a.html',
      content: '{#asset b.html}'
    }).then(function () {
      return reporter.documentStore.collection('assets').insert({
        name: 'b.html',
        content: 'hello'
      }).then(function () {
        return reporter.render({
          template: {
            content: '{#asset a.html}',
            recipe: 'html',
            engine: 'none'
          }
        }).then(function (res) {
          res.content.toString().should.be.eql('hello')
        })
      })
    })
  })

  it('should not fail with circle in asset references', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'a.html',
      content: '{#asset b.html}'
    }).then(function () {
      return reporter.documentStore.collection('assets').insert({
        name: 'b.html',
        content: '{#asset a.html}'
      }).then(function () {
        return reporter.render({
          template: {
            content: '{#asset a.html}',
            recipe: 'html',
            engine: 'none'
          }
        }).then(function (res) {
          res.content.toString().should.be.eql('{#asset b.html}')
        })
      })
    })
  })

  it('should be able to link external file and extract it', function () {
    reporter.options.assets = { allowedFiles: '**/test.html' }
    return reporter.documentStore.collection('assets').insert({
      name: 'test.html',
      link: 'test/test.html'
    }).then(function () {
      return reporter.render({
        template: {
          content: '{#asset test.html}',
          recipe: 'html',
          engine: 'none'
        }
      }).then(function (res) {
        res.content.toString().should.be.eql('hello')
      })
    })
  })

  it('should be able to link external file as base64 and extract it', function () {
    reporter.options.assets = { allowedFiles: '**/test.html' }
    return reporter.documentStore.collection('assets').insert({
      name: 'test.html',
      link: 'test/test.html'
    }).then(function () {
      return reporter.render({
        template: {
          content: '{#asset test.html @encoding=base64}',
          recipe: 'html',
          engine: 'none'
        }
      }).then(function (res) {
        res.content.toString().should.be.eql(new Buffer('hello').toString('base64'))
      })
    })
  })

  it('should deny insert not allowed external files', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'test.html',
      link: 'test/test.html'
    }).catch(function (res) {
      return 'ok'
    }).then(function (m) {
      m.should.be.eql('ok')
    })
  })

  it('should extract assets also from scripts', function () {
    return reporter.documentStore.collection('assets').insert({
      name: 'foo.json',
      content: '{ a: "hello" }'
    }).then(function () {
      return reporter.render({
        template: {
          content: ' ',
          recipe: 'html',
          engine: 'none',
          scripts: [{
            content: 'function beforeRender(req, res, done) { var x = {#asset foo.json}; req.template.content = x.a; done() }'
          }]
        }
      }).then(function (res) {
        res.content.toString().should.be.eql('hello')
      })
    })
  })
})

