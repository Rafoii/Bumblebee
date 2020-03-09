import { trimCharacters, pakoFernet } from './utils/functions.js'
import { findOneOrCreate } from './utils/controllers'

require('dotenv/config')
const express = require('express')
const bodyParser = require('body-parser')
const mongoose = require('mongoose')
const session = require('express-session')

const app = express()

var server = require('http').createServer(app)

const { version } = require('./package.json')

var appUrl
var appHost
// var apiUrl
var base
var wsKernelBase

var whiteList = []

const sl = `
`

function updateHost (host = 'localhost') {
  var kernelHost = process.env.KERNEL_HOST || host
  var kernelPort = process.env.KERNEL_PORT || 8888

  base = 'http://' + kernelHost + ':' + kernelPort
  wsKernelBase = 'ws://' + kernelHost + ':' + kernelPort

  appHost = process.env.APP_HOST || host
  var appPort = process.env.APP_PORT || 3000

  appUrl = `${appHost}:${appPort}`

  // var apiHost = process.env.HOST || host
  // var apiPort = process.env.PORT || 5000

  // apiUrl = `${apiHost}:${apiPort}`
}

updateHost()

if (!process.env.DISABLE_CORS) {
  const cors = require('cors')

  whiteList = [
    'http://' + appUrl,
    'https://' + appUrl,
    'http://' + appHost,
    'https://' + appHost
  ]

  var corsOptions = {
    origin: function (origin, callback) {
      if (whiteList.indexOf(origin) !== -1 || !origin) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'))
      }
    },
    optionsSuccessStatus: 200
  }

  app.use(cors(corsOptions))
}

app.use(bodyParser.urlencoded({
  extended: true
}))

app.use(bodyParser.json({
  limit: '100mb'
}))

mongoose.connect('mongodb://localhost/bumblebee', { useNewUrlParser: true, useUnifiedTopology: true })

const appSecret = process.env.APP_SECRET || '6um61e6ee'

app.use(session({
  secret: appSecret,
  resave: true,
  saveUninitialized: false
}))

const apiRoutes = require('./api-routes')

app.use('/api', apiRoutes)

app.get('/', (req, res) => {
  if (req.userContext && req.userContext.userinfo) {
    res.send(`Bumblebee API v${version} - ${req.userContext.userinfo.name}!`)
  } else {
    res.send(`Bumblebee API v${version}`)
  }
})

var sockets = []

var kernels = []

app.post('/dataset', (req, res) => {
  var socketName = req.body.queue_name || req.body.session || req.body.session

  if (!socketName || !req.body.data) {
    res.send({ status: 'error', message: '"session/username" and "data" fields required' })
  } else if (!sockets[socketName]) {
    res.send({ status: 'error', message: 'Socket with client not found' })
  } else {
    var datasetData = req.body.data.toString()
    sockets[socketName].emit('dataset', datasetData)
    res.send({ message: 'Dataset sent' })
  }
})

const Server = require('socket.io')
const io = new Server(server)

const Row = require('./models/row')
const Session = require('./models/session')
const Dataset = require('./models/dataset')

const createRows = async function (rows, dataset) {
  for (let i = 0; i < rows.length; i++) {
    try {
      var row = new Row()
      row.value = rows[i % rows.length] || []
      row.dataset = dataset
      await row.save()
    } catch (err) {
      console.error('"""', err, '"""')
    }
  }
}

const newSocket = function (socket, session) {
  sockets[session] = socket

  socket.emit('success')

  socket.on('initialize', async (payload) => {
    var userSession = payload.session

    var result

    var tries = 10

    while (tries--) {
      result = await createKernel(userSession, payload.engine ? payload.engine : 'dask')
      if (result.status === 'error') {
        console.log('"""', result, '"""')
        console.log('# Kernel error, retrying')
        await deleteKernel(userSession)
      } else {
        console.log('"""', result, '"""')
        break
      }
    }

    socket.emit('reply', { ...result, timestamp: payload.timestamp })
  })

  socket.on('run', async (payload) => {
    var userSession = payload.session
    var result = await runCode(`${payload.code}`, userSession)
    // console.log({result})
    socket.emit('reply', { ...result, timestamp: payload.timestamp })
  })

  socket.on('cells', async (payload) => {
    var userSession = payload.session
    var userKey = payload.key
    var result = await runCode(`${payload.code}` +
    sl +
    `df.ext.send(output="json", infer=False, advanced_stats=False${payload.name ? (', name="' + payload.name + '"') : ''})`,
    userSession, userKey
    )
    socket.emit('reply', { ...result, timestamp: payload.timestamp })
  })

  return socket
}

io.on('connection', async (socket) => {
  const session = socket.handshake.query.session

  if (!session) {
    socket.disconnect()
    return
  }

  if (sockets[session] === undefined || !sockets[session].connected || sockets[session].disconnected) {
    socket = newSocket(socket, session)
    return
  }

  setTimeout(() => {
    if (sockets[session] === undefined || !sockets[session].connected || sockets[session].disconnected) {
      newSocket(socket, session)
      return
    }
    socket.emit('new-error', 'Session already exists. Change your session name.')
    socket.disconnect()
  }, 2000)
})

const request = require('request-promise')

const uuidv1 = require('uuid/v1')

const runCode = function (code = '', userSession = '', saveRows = false) {
  return new Promise(async function (resolve, reject) {
    if (!userSession) { resolve({ error: 'userSession is empty' }) }

    try {
      const versionResponse = await request({
        uri: `${base}/api`,
        method: 'GET',
        headers: {}
      })

      const version = JSON.parse(versionResponse).version

      if (kernels[userSession] === undefined) {
        console.log('# Jupyter Kernel Gateway Version', version)

        const uuid = Buffer.from(uuidv1(), 'utf8').toString('hex')

        const response = await request({
          uri: `${base}/api/kernels`,
          method: 'POST',
          headers: {}
        })

        kernels[userSession] = { kernel: JSON.parse(response), uuid }

        console.log('# Kernel ID for', userSession, 'is', kernels[userSession].kernel.id)
      }

      var content = { code: code + '\n', silent: false }

      var hdr = {
        msg_id: kernels[userSession].uuid,
        session: kernels[userSession].uuid,
        date: new Date().toISOString(),
        msg_type: 'execute_request',
        version: versionResponse.version
      }

      var codeMsg = {
        header: hdr,
        parent_header: hdr,
        metadata: {},
        content: content
      }

      const WebSocketClient = require('websocket').client

      var client = new WebSocketClient({ closeTimeout: 20 * 60 * 1000 })

      client.on('connectFailed', async function (error) {
        console.warn('Connection to Jupyter Kernel Gateway failed')
        resolve({ status: 'error', content: error, error: 'Connection to Jupyter Kernel Gateway failed' })
      })

      client.on('connect', function (connection) {
        connection.on('message', async function (message) {
          var parsedMessage = JSON.parse(message.utf8Data)

          // if (parsedMessage.content.code)
          //   console.log({ code: parsedMessage.content.code })

          if (message.type !== 'utf8') {
            connection.close()
            // console.error("Message type error", parsedMessage.content)
            resolve({ status: 'error', content: 'Response from gateway is not utf8 type', error: 'Message type error' })
          } else if (parsedMessage.msg_type === 'error') {
            connection.close()
            // console.error("Error", parsedMessage.content)
            resolve({ status: 'error', content: parsedMessage.content, error: 'Error' })
          } else if (parsedMessage.msg_type === 'execute_result') {
            const response = parsedMessage.content.data['text/plain']

            if (saveRows) {
              try {
                const parsedResponse = JSON.parse(trimCharacters(response, "'"))

                const currentSession = await findOneOrCreate(Session, { userSession }, { userSession, queue_name: parsedResponse.queue_name })

                const data = pakoFernet(saveRows, parsedResponse.data)

                const dataset = await findOneOrCreate(Dataset, { meta: data, session: currentSession._id })

                // currentSession TODO: add dataset to currentSession.datasets Array and save

                await Row.deleteMany({ dataset })

                const rows = [...data.sample.value]

                if (data.sample.value && data.sample.value[0] && data.sample.value.length * data.sample.value[0].length > 700) {
                  delete data.sample
                }

                createRows(rows, dataset._id)

                data.sample_length = rows.length

                // data.sample_length Math.min(data.summary.sample_size, data.summary.rows_count, rows.length)

                data.id = (dataset && dataset._id) ? dataset._id : '0'

                resolve({ status: 'ok', content: data })
              } catch (error) {
                console.error('"""', error, '"""')
                resolve({ status: 'error', content: error })
              }
            } else {
              resolve({ status: 'ok', content: response })
            }

            connection.close()
          }
          // else {
          // console.warn('# Received message with unhandled msg_type')
          // console.log({msg_type: parsedMessage.msg_type})
          // resolve({ status: 'error', content: parsedMessage })
          // }
        })

        connection.on('error', async function (error) {
          console.error('"""Connection Error', error, '"""')
          connection.close()
          resolve({ status: 'error', content: error, error: 'Connection error' })
        })

        connection.on('close', function (reason) {
          // console.log('Connection closed before response, reason: ' + reason)
          resolve({ status: 'error', retry: true, error: 'Connection to Jupyter Kernel Gateway closed before response', content: reason })
        })

        if (process.env.NODE_ENV != 'production') { console.log(code) }

        connection.sendUTF(JSON.stringify(codeMsg))
      })

      client.on('disconnect', async function (reason) {
        // console.log('Client disconnected')
        resolve({ status: 'disconnected', retry: true, error: 'Client disconnected', content: reason })
      })

      // console.log('Connecting client')
      client.connect(`${wsKernelBase}/api/kernels/${kernels[userSession].kernel.id}/channels`)
    } catch (error) {
      if (error.error) { resolve({ status: 'error', ...error, content: error.message }) } else { resolve({ status: 'error', error: 'Internal error', content: error }) }
    }
  })
}

const deleteKernel = async function (session) {
  try {
    if (kernels[session] != undefined) {
      var _id = kernels[session].kernel.id
      kernels[session] = undefined
      await request({
        uri: `${base}/api/kernels/${_id}`,
        method: 'DELETE',
        headers: {}
      })
      console.log('# Deleting Jupyter Kernel Gateway session for', session, _id)
    }
  } catch (err) {}
}

const createKernel = async function (userSession, engine) {
  if (kernels[userSession] == undefined) {
    return await runCode(`
from optimus import Optimus
op = Optimus("${engine}", n_workers=4, threads_per_worker=2, processes=False, memory_limit="3G", comm=True)
'kernel init optimus init ' + op.__version__ + '  ' + op.engine`, userSession)
  } else {
    return await runCode(`
_status = 'kernel ok '

try:
	op
	_status += 'optimus ok '+ op.__version__ + ' ' + op.engine
	try:
		df
		_status += 'dataframe ok '
	except NameError:
		_status += ''
except NameError:
	from optimus import Optimus
	op = Optimus("${engine}", n_workers=4, threads_per_worker=2, processes=False, memory_limit="3G", comm=True)
	_status = 'optimus init ' + op.__version__ + ' ${engine} '

_status`, userSession)
  }
}

const startServer = async () => {
  const port = process.env.PORT || 5000
  const host = process.env.HOST || '0.0.0.0'
  var _server = server.listen(port, host, async () => {
    console.log(`# Bumblebee-api v${version} listening on ${host}:${port}`)

    try {
      const response = await request({
        uri: `${base}/api/kernels`,
        method: 'GET',
        headers: {}
      })

      const kernels = JSON.parse(response)

      if (process.env.NODE_ENV === 'production') {
        kernels.forEach(async kernel => {
          console.log(`# Deleting kernel ${kernel.id}`)
          await request({
            uri: `${base}/api/kernels/${kernel.id}`,
            method: 'DELETE',
            headers: {}
          })
        })
      }
    } catch (error) {}
  })
  _server.timeout = 10 * 60 * 1000
}

startServer()
