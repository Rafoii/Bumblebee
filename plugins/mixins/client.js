import io from 'socket.io-client'

let socket
const promises = {}

const apiUrl = process.env.API_URL || 'http://localhost:5000'

export default {

  data () {
    return {
      socketAvailable: false
    }
  },

  mounted () {
    window.evalCode = async (code) => {
      var result = await this.evalCode(code)
      console.log(result)
    }
  },

  methods: {

    async evalCode (code) {
      try {
        var response = await this.socketPost('run', {
          code,
          session: this.$store.state.session
        }, {
          timeout: 0
        })

        return response
      } catch (error) {
        if (error.content && error.content.traceback && error.content.traceback.length) {
          error.content.traceback_escaped = error.content.traceback.map(l =>
            l.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          )
          console.error(error.content.traceback_escaped.join('\n'))
        }
        console.error(error)
        return error
      }
    },

    socketPost (message, payload = {}) {
      var timestamp = new Date().toISOString()

      return new Promise(async (resolve, reject) => {
        try {
          if (!socket) {
            await this.startSocket()
            var response = await this.socketPost('initialize', {
              session: this.$store.state.session,
              engine: this.$store.state.engine
            })
            if (response.status !== 'ok') { throw response.content }
          }
          socket.emit(message, { ...payload, timestamp })
          promises[timestamp] = { resolve, reject }
        } catch (error) {
          reject('Error ' + error)
        }
      })
    },

    handleDatasetResponse (data, key = undefined) {
      if (key === undefined) { key = this.$store.state.key }

      // const fernet = require('fernet')

      // let secret = new fernet.Secret(key)

      // let token = new fernet.Token({
      //   secret,
      //   token: data,
      //   ttl: 0
      // })

      // const pako = require('pako')

      // let originalInput = pako.inflate(atob(token.decode()), {
      //   to: 'string'
      // })

      this.$store.commit('add', {
        dataset: data
      })
    },

    handleError (reason) {
      if (reason) {
        var reason_string = reason.toString()
        if (reason_string.includes('OK') ||
          (
          	reason_string.includes('Socket closed') &&
            (this.$store.state.datasets.length > 0)
          )
        ) {
          this.$store.commit('status')
        } else {
          this.$store.commit('status', new Error(reason))
        }
      }
      this.stopClient()
    },

    stopClient (waiting) {
      this.socketAvailable = false

      const query = Object.assign({}, this.$route.query)
      delete query.key
      delete query.session
      this.$router.replace({ query })

      if (waiting) {
        this.$store.commit('status', 'waiting')
      }

      if (socket) {
        try {
          socket.disconnect()
        } catch (error) {
          console.error(error)
        }
        socket = undefined
        console.log('Socket closed')
      } else { console.warn('Socket already closed') }
    },

    startSocket (session, engine, key) {
      return new Promise((resolve, reject) => {
        if (session) { this.$store.commit('session', session) } else if (this.$store.state.session) { session = this.$store.state.session } else { throw new Error('Credentials not found') }

        if (key) { this.$store.commit('key', key) } else if (this.$store.state.key) { key = this.$store.state.key } else { throw new Error('Credentials not found') }

        socket = io(apiUrl, {
          query: `session=${session}`
        })

        socket.on('new-error', (reason) => {
          console.error('Socket error', reason)
          reject(reason)
        })

        socket.on('dataset', (dataset) => {
          try {
            this.handleDatasetResponse(dataset, key)
          } catch (error) {
            console.error(error)
            reject(error)
          }
        })

        socket.on('reply', (payload) => {
          if (payload.timestamp && promises[payload.timestamp]) {
            if (payload.error) {
              promises[payload.timestamp].reject(payload)
            } else {
              promises[payload.timestamp].resolve(payload)
            }
            delete promises[payload.timestamp]
          } else {
            console.warn('Unhandled reply', payload)
          }
        })

        socket.on('connect', () => {
          console.log('Connection success')
          socket.on('success', () => {
            console.log('Connection confirmed')
            this.socketAvailable = true
            resolve('ok')
          })
        })

        socket.on('connection-error', (reason) => {
          console.warn('Connection failure', reason)
          this.handleError()
          reject('Connection failure')
        })

        socket.on('disconnect', (reason) => {
          console.log('Connection lost', reason)
          this.handleError()
          reject('Connection lost')
        })
      })
    },

    async startClient (session, engine, key) {
      try {
        this.$store.commit('status', 'loading')
        this.$store.commit('session', session)
        this.$store.commit('engine', engine)
        this.$store.commit('key', key)
        var client_status = await this.startSocket(session, engine, key)

        if (client_status === 'ok') { this.$store.commit('status', 'receiving') }
      } catch (error) {
        this.handleError(error)
      }
    }
  }
}
