const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const log = require('npmlog');
const exec = require('../utils/exec');
const retry = require('../utils/retry');

// FBSimulatorControl command line docs
// https://github.com/facebook/FBSimulatorControl/issues/250
// https://github.com/facebook/FBSimulatorControl/blob/master/fbsimctl/FBSimulatorControlKitTests/Tests/Unit/CommandParsersTests.swift

class LogsInfo {
  constructor(udid) {
    const logPrefix = '/tmp/detox.last_launch_app_log.';
    this.simStdout = logPrefix + 'out';
    this.simStderr = logPrefix + 'err';
    const simDataRoot = `$HOME/Library/Developer/CoreSimulator/Devices/${udid}/data`;
    this.absStdout = simDataRoot + this.simStdout;
    this.absStderr = simDataRoot + this.simStderr;
    this.absJoined = `${simDataRoot}${logPrefix}{out,err}`
  }
}

class Fbsimctl {

  constructor() {
    this._operationCounter = 0;
  }

  async list(device) {
    const statusLogs = {
      trying: `Listing devices...`
    };
    const query = this._getQueryFromDevice(device);
    const options = {args: `${query} --first 1 --simulators list`};
    let result = {};
    let simId;
    try {
      result = await this._execFbsimctlCommand(options, statusLogs, 1);
      const parsedJson = JSON.parse(result.stdout);
      simId = _.get(parsedJson, 'subject.udid');
    } catch (ex) {
      log.error(ex);
    }

    if (!simId) {
      throw new Error('Can\'t find a simulator to match with \'' + device + '\', run \'fbsimctl list\' to list your supported devices.\n'
                      + 'It is advised to only state a device type, and not to state iOS version, e.g. \'iPhone 7\'');
    }

    return simId;
  }

  async boot(udid) {
    let initialState;
    await retry({retries: 10, interval: 1000}, async() => {
      const initialStateCmdResult = await this._execFbsimctlCommand({args: `${udid} list`}, undefined, 1);
      initialState = _.get(initialStateCmdResult, 'stdout', '') === '' ? undefined :
          _.get(JSON.parse(_.get(initialStateCmdResult, 'stdout')), 'subject.state');
      if(initialState === undefined) {
        log.info(`Couldn't get the state of ${udid}`);
        throw `Couldn't get the state of the device`;
      }
      if(initialState === 'Shutting Down') {
        log.info(`Waiting for device ${udid} to shut down`);
        throw `The device is in 'Shutting Down' state`;
      }
    });

    if(initialState === 'Booted') {
      log.info(`Device ${udid} is already booted`);
      return;
    }
    
    if(initialState === 'Booting') {
      log.info(`Device ${udid} is already booting`);
    } else {
      const launchBin = "/bin/bash -c '`xcode-select -p`/Applications/Simulator.app/Contents/MacOS/Simulator " +
                        `--args -CurrentDeviceUDID ${udid} -ConnectHardwareKeyboard 0 ` +
                        "-DeviceSetPath $HOME/Library/Developer/CoreSimulator/Devices > /dev/null 2>&1 < /dev/null &'";
      await exec.execWithRetriesAndLogs(launchBin, undefined, {
        trying: `Launching device ${udid}...`,
        successful: ''
      }, 1);
    }

    return await this._execFbsimctlCommand({args: `--state booted ${udid} list`}, {
      trying: `Waiting for device ${udid} to boot...`,
      successful: `Device ${udid} booted`
    });
  }

  async install(udid, absPath) {
    const statusLogs = {
      trying: `Installing ${absPath}...`,
      successful: `${absPath} installed`
    };
    const options = {args: `${udid} install ${absPath}`};
    return await this._execFbsimctlCommand(options, statusLogs);
  }

  async uninstall(udid, bundleId) {
    const statusLogs = {
      trying: `Uninstalling ${bundleId}...`,
      successful: `${bundleId} uninstalled`
    };
    const options = {args: `${udid} uninstall ${bundleId}`};
    try {
      await this._execFbsimctlCommand(options, statusLogs, 1);
    } catch (ex) {
      //that's ok
    }
  }

  async launch(udid, bundleId, launchArgs) {
    const args = [];
    _.forEach(launchArgs, (value, key) => {
      args.push(`${key} ${value}`);
    });

    const logsInfo = new LogsInfo(udid);
    const launchBin = `/bin/cat /dev/null >${logsInfo.absStdout} 2>${logsInfo.absStderr} && ` +
                      `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="${this._getFrameworkPath()}" ` +
                      `/usr/bin/xcrun simctl launch --stdout=${logsInfo.simStdout} --stderr=${logsInfo.simStderr} ` +
                      `${udid} ${bundleId} --args ${args.join(' ')}`;
    const result = await exec.execWithRetriesAndLogs(launchBin, undefined, {
      trying: `Launching ${bundleId}...`,
      successful: `${bundleId} launched. The stdout and stderr logs were recreated, you can watch them with:\n` +
                  `        tail -F ${logsInfo.absJoined}`
    }, 1);
    return parseInt(result.stdout.trim().split(':')[1]);
  }

  async sendToHome(udid) {
    const result = await exec.execWithRetriesAndLogs(`/usr/bin/xcrun simctl launch ${udid} com.apple.springboard`);
    return parseInt(result.stdout.trim().split(':')[1]);
  }

  getLogsPaths(udid) {
    const logsInfo = new LogsInfo(udid);
    return {
      stdout: logsInfo.absStdout,
      stderr: logsInfo.absStderr
    }
  }

  async terminate(udid, bundleId) {
    const launchBin = `/usr/bin/xcrun simctl terminate ${udid} ${bundleId}`;
    await exec.execWithRetriesAndLogs(launchBin, undefined, {
      trying: `Terminating ${bundleId}...`,
      successful: `${bundleId} terminated`
    }, 1);
  }

  async shutdown(udid) {
    const options = {args: `${udid} shutdown`};
    await this._execFbsimctlCommand(options);
  }

  async open(udid, url) {
    const options = {args: `${udid} open ${url}`};
    await this._execFbsimctlCommand(options);
  }

  async isDeviceBooted(udid) {
    const options = {args: `${udid} list`};
    const result = await this._execFbsimctlCommand(options);
    return JSON.parse(result.stdout).subject.state !== 'Booted';
  }

  async setLocation(udid, lat, lon) {
    const options = {args: `${udid} set_location ${lat} ${lon}`};
    await this._execFbsimctlCommand(options);
  }

  async _execFbsimctlCommand(options, statusLogs, retries, interval) {
    const bin = `fbsimctl --json`;
    return await exec.execWithRetriesAndLogs(bin, options, statusLogs, retries, interval);
  }

  _getFrameworkPath() {
    const frameworkPath = path.join(__dirname, `/../../Detox.framework/Detox`);
    if (!fs.existsSync(frameworkPath)) {
      throw new Error(`Detox.framework not found at ${frameworkPath}`);
    }
    return frameworkPath;
  }

  _getQueryFromDevice(device) {
    let res = '';
    const deviceParts = device.split(',');
    for (let i = 0; i < deviceParts.length; i++) {
      res += `"${deviceParts[i].trim()}" `;
    }
    return res.trim();
  }
}

module.exports = Fbsimctl;
