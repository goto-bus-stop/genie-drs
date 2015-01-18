var fs = require('fs')
  , DRSFile = require('./DRSFile')
  , PaletteFile = require('./PaletteFile')
  , SLPFile = require('./SLPFile')
  , WAVFile = require('./WAVFile')
  , Struct = require('awestruct')

var t = Struct.types

module.exports = DRS

var HEADER_SIZE = 64
  , TABLE_META_SIZE = 12
  , FILE_META_SIZE = 12

var unknownByteMap = {
  bin: 0x61
, slp: 0x20
, wav: 0x20
}

var merge = function (base, obj) {
  Object.keys(obj).forEach(function (key) {
    base[key] = obj[key]
  })
}
var reverse = function (str) { return str.split('').reverse().join('') }

var headerStruct = Struct({
  copyright: t.char(40)
, fileVersion: t.char(4)
, fileType: t.char(12)
, numTables: t.int32
, firstFileOffset: t.int32
})

var tableStruct = Struct({
  unknownByte: t.uint8
, ext: t.char(3).transform(reverse)
, offset: t.int32
, numFiles: t.int32
})

/**
 * Represents a DRS file.
 * @constructor
 * @param {string} file Path to a .DRS file.
 */
function DRS(file) {
  if (!(this instanceof DRS)) return new DRS(file)

  this.files = {}
  this.newOffset = {}
  this.tables = []
  this.filename = file
  this.fd = null
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
  return HEADER_SIZE + TABLE_META_SIZE * this.tables.length +
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
    , fd = this.fd
  // make sure we have an open file first
  if (this.fd === null) {
    return this.open(function (e) {
      if (e) cb(e)
      else drs.read(cb)
    })
  }

  var fileOffset = 0

  // header is 64 bytes
  fs.read(fd, new Buffer(HEADER_SIZE), 0, HEADER_SIZE, 0, onHeader)

  function onHeader(err, bytesRead, buf) {
    if (err) return cb(err)

    merge(drs, headerStruct(buf.slice(fileOffset)))

    fileOffset += buf.length
    fs.read(fd, new Buffer(TABLE_META_SIZE * drs.numTables), 0, TABLE_META_SIZE * drs.numTables, fileOffset, onTableInfo)
  }

  function onTableInfo(err, bytesRead, buf) {
    if (err) return cb(err)

    // Tables reader
    var tables = t.array(drs.numTables, tableStruct.transform(function (tab) { tab.files = []; return tab }))

    drs.tables = tables(buf)
    var totalFiles = drs.tables.reduce(function (total, table) {
      return total + table.numFiles
    }, 0)

    fileOffset += buf.length
    fs.read(fd, new Buffer(FILE_META_SIZE * totalFiles), 0, FILE_META_SIZE * totalFiles, fileOffset, onTables)
  }

  function onTables(err, bytesRead, buf) {
    if (err) return cb(err)

    var offset = 0
    drs.tables.forEach(function (table) {
      var file, i, l
      for (i = 0, l = table.numFiles; i < l; i++) {
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
  var tableI = 0
    , tableL = this.tables.length
    , fileI, fileL
    , table
  for (; tableI < tableL; tableI++) {
    table = this.tables[tableI]
    fileI = 0
    fileL = table.numFiles
    for (; fileI < fileL; fileI++) {
      if (table.files[fileI].id === id) {
        return table.files[fileI]
      }
    }
  }
  return null
}

/**
 * Reads a file's content from the DRS by id.
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
  fs.read(this.fd, new Buffer(file.size), 0, file.size, file.offset, function (e, bytesRead, buf) {
    if (e) return cb(e)
    var fileInst
    if (file.type === 'slp') {
      fileInst = new SLPFile(buf, file)
    }
    else if (file.type === 'wav') {
      fileInst = new WAVFile(buf, file)
    }
    else if (file.type === 'bin' && buf.slice(0, 8).toString('ascii') === 'JASC-PAL') {
      fileInst = new PaletteFile(buf, file)
    }
    else {
      fileInst = new DRSFile(buf, file)
    }
    cb(null, fileInst)
  }.bind(this))
}

/**
 * Closes the file.
 * @param {function} cb Callback passed straight to `fs.close`.
 */
DRS.prototype.close = function (cb) {
  fs.close(this.fd, cb)
}
