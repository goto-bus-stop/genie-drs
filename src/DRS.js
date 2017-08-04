var fs = require('fs')
var through = require('through2')
var pump = require('pump')
var concat = require('simple-concat')
var Buffer = require('safe-buffer').Buffer
var fromBuffer = require('from2-buffer')
var isBuffer = require('is-buffer')
var Struct = require('awestruct')
var assign = require('object-assign')
var to = require('to2')
var DRSFile = require('./DRSFile')
var PaletteFile = require('./PaletteFile')
var SLPFile = require('./SLPFile')
var WAVFile = require('./WAVFile')

var t = Struct.types

module.exports = DRS

function isStream (stream) {
  return stream &&
    typeof stream === 'object' &&
    typeof stream.pipe === 'function'
}

var HEADER_SIZE_AOE = 64
var HEADER_SIZE_SWGB = 84
var TABLE_META_SIZE = 12
var FILE_META_SIZE = 12

var COPYRIGHT_SWGB = 'Copyright (c) 2001 LucasArts Entertainment Company LLC'

// Parse a numeric table type to a string.
var parseTableType = function (num) {
  for (var ext = '', i = 0; i < 4; i++) {
    ext = String.fromCharCode(num & 0xFF) + ext
    num >>= 8
  }
  return ext
}

// Serialize a table type string to a 32-bit integer.
var serializeTableType = function (str) {
  for (var num = 0, i = 0; i < 4; i++) {
    num = (num << 8) + str.charCodeAt(i)
  }
  return num
}

var headerStruct = function (isSwgb) {
  return Struct({
    copyright: isSwgb ? t.char(60) : t.char(40),
    fileVersion: t.char(4),
    fileType: t.char(12),
    numTables: t.int32,
    firstFileOffset: t.int32
  })
}

var tableStruct = Struct({
  ext: t.uint32.map(parseTableType, serializeTableType),
  offset: t.int32,
  numFiles: t.int32
})

/**
 * Represents a DRS file.
 * @constructor
 * @param {string} file Path to a .DRS file.
 */
function DRS (file) {
  if (!(this instanceof DRS)) return new DRS(file)

  this.files = {}
  this.newOffset = {}
  this.tables = []
  this.filename = file
  this.fd = null
  this.isSWGB = null
}

DRS.File = DRSFile
DRS.SLPFile = SLPFile
DRS.WAVFile = WAVFile
DRS.PaletteFile = PaletteFile

DRS.prototype.getFileCount = function () {
  return this.tables.reduce(function (a, t) { return a + t.files.length }, 0)
}

/**
 * Computes the size of this DRS file.
 * DRS consists of a 64 byte header, an array of 12 byte table infos,
 * an array of 12 byte file infos (the tables), and finally the files.
 * @return {number} The size of this DRS file.
 */
DRS.prototype.getSize = function () {
  var headerSize = this.isSWGB ? HEADER_SIZE_SWGB : HEADER_SIZE_AOE

  return headerSize + TABLE_META_SIZE * this.tables.length +
         FILE_META_SIZE * this.getFileCount() +
         this.getFiles().reduce(function (size, file) { return size + file.size }, 0)
}

/**
 * Opens a DRS file from the file system.
 * @param {string} file Filename to open.
 * @param {function} cb Function to call after opening the file.
 *    Error in first argument, File Descriptor in second (if successful)
 */
DRS.prototype.open = function (cb) {
  fs.open(this.filename, 'r', function (e, fd) {
    if (e) return cb(e)
    this.fd = fd
    cb(null, fd)
  }.bind(this))
}

/**
 * Reads the file tables.
 * @param {function} cb Function to call when finished. Error in first parameter.
 */
DRS.prototype.read = function (cb) {
  var drs = this
  var fd = this.fd
  // make sure we have an open file first
  if (this.fd === null) {
    return this.open(function (e) {
      if (e) cb(e)
      else drs.read(cb)
    })
  }

  var fileOffset = 0

  // header is 64 bytes
  fs.read(fd, Buffer.alloc(HEADER_SIZE_SWGB), 0, HEADER_SIZE_SWGB, 0, onHeader)

  function onHeader (err, bytesRead, buf) {
    if (err) return cb(err)

    drs.isSWGB = buf.slice(0, COPYRIGHT_SWGB.length).toString('ascii') === COPYRIGHT_SWGB

    if (!drs.isSWGB) {
      buf = buf.slice(0, HEADER_SIZE_AOE)
    }

    var readHeader = headerStruct(drs.isSWGB)
    assign(drs, readHeader(buf.slice(fileOffset)))

    fileOffset += buf.length
    fs.read(fd, Buffer.alloc(TABLE_META_SIZE * drs.numTables), 0, TABLE_META_SIZE * drs.numTables, fileOffset, onTableInfo)
  }

  function onTableInfo (err, bytesRead, buf) {
    if (err) return cb(err)

    // Tables reader
    var tables = t.array(drs.numTables, tableStruct.transform(function (tab) { tab.files = []; return tab }))

    drs.tables = tables(buf)
    var totalFiles = drs.tables.reduce(function (total, table) {
      return total + table.numFiles
    }, 0)

    fileOffset += buf.length
    fs.read(fd, Buffer.alloc(FILE_META_SIZE * totalFiles), 0, FILE_META_SIZE * totalFiles, fileOffset, onTables)
  }

  function onTables (err, bytesRead, buf) {
    if (err) return cb(err)

    var offset = 0
    drs.tables.forEach(function (table) {
      var file
      for (var i = 0, l = table.numFiles; i < l; i++) {
        file = {}
        file.id = buf.readInt32LE(offset)
        offset += 4
        file.offset = buf.readInt32LE(offset)
        offset += 4
        file.size = buf.readInt32LE(offset)
        offset += 4
        file.type = table.ext
        table.files.push(file)
      }
    })

    fileOffset += buf.length
    cb()
  }
}

/**
 * Returns all the table entries in the DRS file.
 * @return {Array}
 */
DRS.prototype.getFiles = function () {
  return this.tables.reduce(function (arr, table) {
    return arr.concat(table.files)
  }, [])
}

/**
 * Gets a single table entry from the DRS by its file id.
 * @param {number} id File ID.
 * @return {Object=} Appropriate file entry.
 */
DRS.prototype.getFile = function (id) {
  for (var tableI = 0; tableI < this.tables.length; tableI++) {
    var table = this.tables[tableI]
    for (var i = 0; i < table.numFiles; i++) {
      if (table.files[i].id === id) {
        return table.files[i]
      }
    }
  }
  return null
}

/**
 * Create a read stream for a file in the DRS.
 *
 * @param {number} id File ID.
 *
 * @return {Readable} A Readable stream.
 */
DRS.prototype.createReadStream = function (id) {
  var drs = this

  var stream = through()
  if (!drs.numTables) {
    drs.read(onread)
  } else {
    onread()
  }

  return stream

  function onread (err) {
    if (err) {
      stream.emit('error', err)
      return
    }
    var file = drs.getFile(id)
    if (!file) {
      stream.emit('error', new Error('File ' + id + ' does not exist'))
    }
    stream.emit('meta', file)
    if (file.buffer) {
      pump(fromBuffer(file.buffer), stream)
      return
    }
    pump(fs.createReadStream(drs.filename, {
      fd: drs.fd,
      start: file.offset,
      end: file.offset + file.size - 1,
      autoClose: false
    }), stream)
  }
}

/**
 * Reads a file's content from the DRS by id.
 *
 * @param {number} id File ID.
 * @param {function} cb Function `(err, file)` to call when finished. `file` is a `DRSFile` object.
 */
DRS.prototype.readFile = function (id, cb) {
  var drs = this
  // make sure we've read tables first
  if (!this.numTables) {
    return this.read(function (e) {
      if (e) cb(e)
      else drs.readFile(id, cb)
    })
  }

  var file = this.getFile(id)
  if (file == null) return cb(new Error('Cannot find file #' + id))
  fs.read(this.fd, Buffer.alloc(file.size), 0, file.size, file.offset, function (e, bytesRead, buf) {
    if (e) return cb(e)
    var fileInst
    if (file.type === 'slp ') {
      fileInst = new SLPFile(buf, file)
    } else if (file.type === 'wav ') {
      fileInst = new WAVFile(buf, file)
    } else if (file.type === 'bina' && buf.slice(0, 8).toString('ascii') === 'JASC-PAL') {
      fileInst = new PaletteFile(buf, file)
    } else {
      fileInst = new DRSFile(buf, file)
    }
    cb(null, fileInst)
  })
}

function getTable (drs, type) {
  var table
  for (var i = 0; i < drs.tables.length; i += 1) {
    table = drs.tables[i]
    if (table.ext === type) {
      break
    }
  }

  if (!table) {
    table = {
      ext: type,
      offset: null,
      numFiles: 0,
      files: []
    }
    drs.tables.push(table)
    drs.numTables = drs.tables.length
  }

  return table
}

function newFile (type, id) {
  return {
    id: id,
    offset: null,
    size: null,
    type: type
  }
}

function createFileBufferCallback (file, table, cb) {
  return function onbuffer (err, buffer) {
    if (err) return cb(err)
    file.buffer = buffer
    file.size = buffer.byteLength

    table.files.push(file)
    table.numFiles = table.files.length

    cb(null, file)
  }
}

/**
 * Add a new file to the DRS archive.
 *
 * @param {string} type The file type, i.e. the table in which to store the file.
 *    If a file type is given for which a table does not exist, a new table is created.
 * @param {number} id The new file ID.
 * @param {Buffer|Stream} data File contents.
 * @param {function} cb Function `(err, file)` to call when finished.
 */
DRS.prototype.putFile = function (type, id, data, cb) {
  var file = newFile(type, id)
  var table = getTable(this, type)

  var onbuffer = createFileBufferCallback(file, table, cb)

  if (isBuffer(data)) {
    setTimeout(function () {
      onbuffer(null, data)
    }, 0)
  } else if (isStream(data)) {
    concat(data, onbuffer)
  } else {
    throw new TypeError('Expected a Buffer or a Stream, but got \'' + typeof data + '\'')
  }
}

/**
 * Add a new file to the DRS archive, returning a writable stream.
 *
 * @param {string} type The file type, i.e. the table in which to store the file.
 *    If a file type is given for which a table does not exist, a new table is created.
 * @param {number} id The new file ID.
 * @param {function} cb Function `(err, file)` to call when finished.
 */
DRS.prototype.createWriteStream = function (type, id) {
  var file = newFile(type, id)
  var table = getTable(this, type)

  var data = []
  var cb = createFileBufferCallback(file, table, onfinish)
  var stream = to(function (chunk, enc, next) {
    data.push(chunk)
    next()
  }, function (next) {
    cb(null, Buffer.concat(data))
    next()
  })

  function onfinish (err, file) {
    if (err) stream.emit('error', err)
    else stream.emit('meta', file)
  }

  return stream
}

/**
 * Closes the file.
 * @param {function} cb Callback passed straight to `fs.close`.
 */
DRS.prototype.close = function (cb) {
  fs.close(this.fd, cb)
}
