const got = require('got')
const protobuf = require('protobufjs')
const path = require('path')

module.exports = class Batcher {
  constructor (options) {
    this.options = options
    this.interval = this.options.interval
      ? Number(this.options.interval) * 1000
      : 5000
    this.circuitBreakerInterval = 60000
    this.batch = {
      streams: []
    }
  }
  wait (duration) {
    return new Promise(resolve => {
      setTimeout(resolve, duration)
    })
  }
  pushLogEntry (logEntry) {
    if (this.options.json) {
      this.batch.streams.push(logEntry)
    } else {
      const matchedIndex = this.batch.streams.findIndex(
        stream => stream.labels === logEntry.labels
      )
      if (matchedIndex !== -1) {
        this.batch.streams[matchedIndex].entries.push(logEntry.entries)
      } else {
        this.batch.streams.push(logEntry)
      }
    }
  }
  clearBatch () {
    this.batch.streams = []
  }
  sendBatchToLoki () {
    return new Promise((resolve, reject) => {
      if (this.batch.streams.length === 0) {
        resolve()
      } else {
        let buffer, requestOptions

        if (!this.options.json) {
          protobuf.load(path.join(__dirname, 'logproto.proto'), (err, root) => {
            if (err) {
              return reject(err)
            }
            const PushRequest = root.lookupType('logproto.PushRequest')

            let streamsBuffer = { streams: [] }
            let streamBuffer = { labels: '', entries: [] }
            let entryBuffer = {}

            this.batch.streams.forEach(stream => {
              streamBuffer.labels = stream.labels

              stream.entries.forEach(entry => {
                entryBuffer.timestamp = entry.ts
                entryBuffer.line = entry.line
                streamBuffer.entries.push(entryBuffer)

                entryBuffer = {}
              })

              streamsBuffer.streams.push(streamBuffer)
              streamBuffer = { labels: '', entries: [] }
            })

            const pushRequest = PushRequest.create(streamsBuffer)
            buffer = PushRequest.encode(pushRequest).finish()
          })
        } else {
          buffer = JSON.stringify(this.batch)
        }

        if (this.options.json) {
          requestOptions = {
            body: buffer,
            headers: { 'Content-Type': 'application/json' }
          }
        } else {
          requestOptions = {
            data: buffer,
            headers: { 'Content-Type': 'application/x-protobuf' }
          }
        }

        got
          .post(this.options.host + '/api/prom/push', requestOptions)
          .then(res => {
            this.clearBatch()
            return resolve()
          })
          .catch(err => {
            console.log(err.body)
            return reject(err)
          })
      }
    })
  }
  async run () {
    while (true) {
      try {
        await this.sendBatchToLoki()
        if (this.interval === this.circuitBreakerInterval) {
          this.interval = Number(options.interval) * 1000
        }
      } catch (e) {
        this.interval = this.circuitBreakerInterval
      }
      await this.wait(this.interval)
    }
  }
}
