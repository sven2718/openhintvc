import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import randomString  from '../utils/randomString';
import Logger from '../utils/Logger';

const L = Logger.getLogger('RemoteFile');

class RemoteFile {
  dataSize : number;
  writtenDataSize : number = 0;

  token : string;
  localFilePath : string;

  remoteHost : string;
  remoteBaseName : string;

  fd : number;

  constructor() {
    L.trace('constructor');
  }

  setToken(token : string) {
    this.token = token;
  }

  getToken() {
    L.trace('getRemoteBaseName');
    return this.token;
  }

  setDisplayName(displayName : string) {
    var displayNameSplit = displayName.split(':');

    if (displayNameSplit.length === 1) {
      this.remoteHost = "";

    } else {
      this.remoteHost = displayNameSplit.shift();
    }

    this.remoteBaseName = displayNameSplit.join(":");
  }

  getHost() {
    L.trace('getHost', this.remoteHost);
    return this.remoteHost;
  }

  getRemoteBaseName() {
    L.trace('getRemoteBaseName');
    return this.remoteBaseName;
  }

  createLocalFilePath() {
    L.trace('createLocalFilePath');
    this.localFilePath = path.join(os.tmpdir(), randomString(10), this.getRemoteBaseName());
  }

  getLocalDirectoryName() {
    L.trace('getLocalDirectoryName', path.dirname(this.localFilePath || ""));
    if (!this.localFilePath) {
      return;
    }
    return path.dirname(this.localFilePath);
  }

  createLocalDir() {
    L.trace('createLocalDir');
    fse.mkdirsSync(this.getLocalDirectoryName());
  }

  getLocalFilePath() {
    L.trace('getLocalFilePath', this.localFilePath);
    return this.localFilePath;
  }

  openSync() {
    L.trace('openSync');
    this.fd = fs.openSync(this.getLocalFilePath(), 'w');
  }

  closeSync() {
    L.trace('closeSync');
    fs.closeSync(this.fd);
    this.fd = null;
  }

  initialize() {
    L.trace('initialize');
    this.createLocalFilePath();
    this.createLocalDir();
    this.openSync();
  }

  writeSync(buffer : any, offset : number, length : number) {
    L.trace('writeSync');
    if (this.fd) {
      L.debug('writing data');
      fs.writeSync(this.fd, buffer, offset, length, undefined);
    }
  }

  readFileSync() : Buffer {
    L.trace('readFileSync');
    return fs.readFileSync(this.localFilePath);
  }

  appendData(buffer : Buffer) {
    L.trace('appendData', buffer.length);

    var length = buffer.length;
    if (this.writtenDataSize + length > this.dataSize) {
      length = this.dataSize - this.writtenDataSize;
    }

    this.writtenDataSize += length;
    L.debug("writtenDataSize", this.writtenDataSize);

    this.writeSync(buffer, 0, length);
  }

  setDataSize(dataSize : number) {
    L.trace('setDataSize', dataSize);
    this.dataSize = dataSize;
  }

  getDataSize() : number {
    L.trace('getDataSize');
    L.debug('getDataSize', this.dataSize);
    return this.dataSize;
  }

  isEmpty() : boolean {
    L.trace('isEmpty');
    L.debug('isEmpty?', this.dataSize == null);
    return this.dataSize == null;
  }

  isReady() : boolean {
    L.trace('isReady');
    L.debug('isReady?', this.writtenDataSize == this.dataSize);
    return this.writtenDataSize == this.dataSize;
  }
}

export default RemoteFile;