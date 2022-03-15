// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2020  flexiWAN Ltd.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const configs = require('../configs')();
const createError = require('http-errors');
const applications = require('../models/applications');
const mongoConns = require('../mongoConns.js')();
const logger = require('../logging/logging')({
  module: module.filename,
  type: 'req'
});
const { devices } = require('../models/devices');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);

const modifyDeviceApply = require('./modifyDevice').apply;

const {
  validateDeviceConfigurationRequest,
  validateUninstallRequest,
  getAppAdditionsQuery,
  getDeviceSpecificConfiguration
} = require('../applicationLogic/applications');

const { getJobParams } = require('../applicationLogic/applications');

const handleInstallOp = async (app, device, deviceConfiguration, idx, session) => {
  const appId = app._id.toString();

  const deviceSpecificConfigurations =
    getDeviceSpecificConfiguration(app, device, deviceConfiguration, idx);

  const query = { _id: device._id, org: device.org };
  const update = {};

  const appExists =
    device.applications &&
    device.applications.length > 0 &&
    device.applications.some(a => a.app && a.app.toString() === appId);

  if (appExists) {
    query['applications.app'] = appId;
    update.$set = {
      'applications.$.status': 'installing',
      'applications.$.configuration': deviceSpecificConfigurations
    };
  } else {
    update.$push = {
      applications: {
        app: app._id,
        identifier: app.appStoreApp.identifier,
        status: 'installing',
        requestTime: Date.now(),
        configuration: deviceSpecificConfigurations
      }
    };
  };

  // check if need to install more things together with the application
  const additions = getAppAdditionsQuery(app, device, 'install');
  if (!update.$set) {
    update.$set = {};
  }

  update.$set = {
    ...update.$set,
    ...additions
  };

  await devices.findOneAndUpdate(
    query,
    update,
    { upsert: false, session: session }
  );
};

const handleUninstallOp = async (app, device, session) => {
  const query = {
    _id: device._id,
    org: device.org,
    'applications.app': app._id
  };
  const update = {
    $set: { 'applications.$.status': 'uninstalling' }
  };

  // check if need to remove more things together with the application
  const additions = getAppAdditionsQuery(app, device, 'uninstall');
  update.$set = {
    ...update.$set,
    ...additions
  };

  await devices.updateOne(query, update, { upsert: false }).session(session);
};

const handleConfigOp = async (app, device, session) => {
  const query = {
    _id: device._id,
    org: device.org,
    'applications.app': app._id
  };
  const update = {
    $set: { 'applications.$.status': 'installing' }
  };

  // check if need to remove more things together with the application
  const additions = getAppAdditionsQuery(app, device, 'config');
  update.$set = {
    ...update.$set,
    ...additions
  };
  await devices.updateOne(query, update, { upsert: false }).session(session);
};

const handleUpgradeOp = async (app, device, session) => {
  const query = {
    _id: device._id,
    org: device.org,
    'applications.app': app._id
  };

  const update = {
    $set: { 'applications.$.status': 'upgrading' }
  };
  await devices.updateOne(query, update, { upsert: false }).session(session);
};

/**
 * Creates and queues applications jobs.
 * @async
 * @param  {Array}    deviceList    an array of the devices to be modified
 * @param  {Object}   user          User object
 * @param  {Object}   data          Additional data used by caller
 * @return {None}
 */
const apply = async (deviceList, user, data) => {
  const { org } = data;
  const { op, id, deviceConfiguration } = data.meta;

  let session;

  // Get application
  const app = await applications.findOne({
    org: org,
    _id: id
  }).populate('appStoreApp').lean();

  if (!app) {
    throw createError(500, 'The requested app was not purchased');
  }

  // if the user selected multiple devices, the request goes to devicesApplyPOST function
  // and the deviceList variable here contain *all* the devices even they are not selected.
  // therefore we need to filter this array by devices array that comes from request body.
  // if the user select only one device, the data.devices is equals to null
  // and this device is passed in the url path
  if (data.devices) {
    deviceList = deviceList.filter(d => data.devices.hasOwnProperty(d._id));
  }

  if (op === 'install' && deviceConfiguration) {
    // validate device configuration
    const { valid, err } = await validateDeviceConfigurationRequest(
      app, deviceConfiguration, deviceList);
    if (!valid) {
      throw createError(500, err);
    }
  }

  if (op === 'uninstall') {
    // validate uninstall request
    const { valid, err } = await validateUninstallRequest(app, deviceList);
    if (!valid) {
      throw createError(500, err);
    }
  }

  try {
    session = await mongoConns.getMainDB().startSession();
    await session.withTransaction(async () => {
      for (let i = 0; i < deviceList.length; i++) {
        const device = deviceList[i];
        const idx = i;
        if (op === 'install') {
          await handleInstallOp(app, device, deviceConfiguration, idx, session);
        } else if (op === 'uninstall') {
          await handleUninstallOp(app, device, session);
        } else if (op === 'config') {
          await handleConfigOp(app, device, session);
        } else if (op === 'upgrade') {
          await handleUpgradeOp(app, device, session);
        }
      }
    });
  } catch (error) {
    if (session) session.abortTransaction();
    throw error.name === 'MongoError' ? new Error() : error;
  } finally {
    session.endSession();
  }

  const requestTime = Date.now();

  // Queue applications jobs. Fail the request if
  // there are jobs that failed to be queued
  const jobs = await queueApplicationJob(
    deviceList,
    op,
    requestTime,
    app,
    user,
    org
  );

  const failedToQueue = [];
  const succeededToQueue = [];
  jobs.forEach((job) => {
    switch (job.status) {
      case 'rejected': {
        failedToQueue.push(job);
        break;
      }
      case 'fulfilled': {
        const { id } = job.value;
        succeededToQueue.push(id);
        break;
      }
      default: {
        break;
      }
    }
  });

  let status = 'completed';
  let message = '';
  if (failedToQueue.length !== 0) {
    const failedDevices = failedToQueue.map((ent) => {
      const { job } = ent.reason;
      const { _id } = job.data.response.data.application.device;
      return _id;
    });

    logger.error('Application jobs queue failed', {
      params: { jobId: failedToQueue[0].reason.job.id, devices: failedDevices }
    });

    // Update devices application status in the database
    await devices.updateMany(
      {
        _id: { $in: failedDevices },
        org: org,
        'applications.app': app._id
      },
      { $set: { 'applications.$.status': 'job queue failed' } },
      { upsert: false }
    );

    status = 'partially completed';
    message = `${succeededToQueue.length} of ${jobs.length} application jobs added`;
  }

  return {
    ids: succeededToQueue,
    status,
    message
  };
};

const queueApplicationJob = async (
  deviceList,
  op,
  requestTime,
  application,
  user,
  org
) => {
  const jobs = [];

  // set job title to be shown to the user on Jobs screen
  // and job message to be handled by the device
  let jobTitle = '';
  let message = '';
  if (op === 'install') {
    jobTitle = `Install ${application.appStoreApp.name} application`;
    message = 'application-install';
  } else if (op === 'upgrade') {
    jobTitle = `Upgrade ${application.appStoreApp.name} application`;
    message = 'application-upgrade';
  } else if (op === 'config') {
    jobTitle = `Configure ${application.appStoreApp.name} application`;
    message = 'application-configure';
  } else if (op === 'uninstall') {
    jobTitle = `Uninstall ${application.appStoreApp.name} application`;
    message = 'application-uninstall';
  } else {
    return jobs;
  }

  // generate job for each selected device
  for (let i = 0; i < deviceList.length; i++) {
    const dev = deviceList[i];

    const newDevice = await devices.findOne({ _id: dev._id });
    const params = await getJobParams(newDevice, application, op);

    const tasks = [{
      entity: 'agent',
      message: message,
      params: params
    }];

    // response data
    const data = {
      application: {
        device: { _id: dev._id },
        app: application,
        requestTime: requestTime,
        op: op,
        org: org
      }
    };

    // during application installation, we can change the device,
    // e.g. adding firewall rules.
    // Here we call modifyDevice function to send the needed jobs
    await modifyDeviceApply([dev], 'system', {
      org: org,
      newDevice: newDevice
    });

    jobs.push(
      deviceQueues.addJob(
        dev.machineId,
        user.username,
        org,
        // Data
        {
          title: jobTitle,
          tasks: tasks
        },
        // Response data
        {
          method: 'application',
          data: data
        },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null
      )
    );
  }

  return Promise.allSettled(jobs);
};

/**
 * Called when add/remove application is job completed.
 * Updates the status of the application in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const complete = async (jobId, res) => {
  logger.info('Application job completed', {
    params: { result: res, jobId: jobId }
  });

  const { op, org, app, device } = res.application;
  try {
    const update = {};
    if (op === 'uninstall') {
      update.$pull = { applications: { app: app._id } };
    } else { // install, configure, upgrade
      update.$set = { 'applications.$.status': 'installed' };
    }

    // on complete, update db with updated data
    if (op === 'upgrade') {
      // update version on db
      await applications.updateOne(
        { org: org, _id: app._id },
        { $set: { installedVersion: app.appStoreApp.latestVersion, pendingToUpgrade: false } }
      );
    }

    await devices.findOneAndUpdate(
      {
        _id: device._id,
        org: org,
        'applications.app': app._id
      },
      update,
      { upsert: false }
    );
  } catch (err) {
    logger.error('Device application status update failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
};

/**
 * Called when add/remove application job fails and
 * Updates the status of the application in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.error('Application job failed', {
    params: { result: res, jobId: jobId }
  });

  const { op, org, app } = res.application;
  const { _id } = res.application.device;

  try {
    let status = '';

    switch (op) {
      case 'install':
        status = 'installation failed';
        break;
      case 'config':
        status = 'configuration failed';
        break;
      case 'uninstall':
        status = 'uninstallation failed';
        break;
      default:
        status = 'job failed';
        break;
    }

    await devices.updateOne(
      { _id: _id, org: org, 'applications.app': app._id },
      { $set: { 'applications.$.status': status } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Device policy status update failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
};

/**
 * Called when add/remove application job is removed either
 * by user or due to expiration. This method should run
 * only for tasks that were deleted before completion/failure
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  const { org, app, device, op } = job.data.response.data.application;
  const { _id } = device;

  if (['inactive', 'delayed'].includes(job._state)) {
    logger.info('Application job removed', {
      params: { job: job }
    });
    // Set the status to "job deleted" only
    // for the last policy related job.
    const status = 'job deleted';
    const query = {
      _id: _id,
      org: org,
      'applications.app': app._id
    };
    try {
      const newDevice = await devices.findOneAndUpdate(
        query,
        { $set: { 'applications.$.status': status } },
        { upsert: false, new: true }
      );

      if (op === 'install') {
        // Additional items may have been installed during the installation process,
        // such as firewall rules. If we delete only the installation job,
        // they may remain in flexiManage DB. Therefore we also delete the additions from the DB.
        // The future sync process will know how to handle sending the appropriate JOBS.
        const additions = getAppAdditionsQuery(app, newDevice, 'uninstall');
        await devices.findOneAndUpdate(
          query,
          { $set: { ...additions } },
          { upsert: false, new: true }
        );
      }
    } catch (err) {
      logger.error('Device application status update failed', {
        params: { job: job, status: status, err: err.message }
      });
    }
  }
};

/**
 * Creates the applications section in the full sync job.
 * @return Object
 */
const sync = async (deviceId, org) => {
  const device = await devices.findOne(
    { _id: deviceId },
    { applications: 1 }
  ).populate({
    path: 'applications.app',
    populate: {
      path: 'appStoreApp'
    }
  }).lean();

  const requests = [];
  const completeCbData = [];
  for (const app of device.applications) {
    const syncStatuses = ['installed', 'installing', 'installation failed', 'configuration failed'];
    if (syncStatuses.includes(app.status)) {
      const params = await getJobParams(device, app.app, 'install');
      requests.push({
        entity: 'agent',
        message: 'application-install',
        params: params
      });

      completeCbData.push({
        username: 'system',
        application: {
          op: 'install',
          app: app.app,
          org,
          device
        }
      });
    }
  }

  return {
    requests,
    completeCbData,
    callComplete: true
  };
};

/**
 * Complete handler for sync job
 * @return void
 */
const completeSync = async (jobId, jobsData) => {
  try {
    for (const data of jobsData) {
      await complete(jobId, data);
    }
  } catch (err) {
    logger.error('Applications sync complete callback failed', {
      params: { jobsData, reason: err.message }
    });
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error,
  remove: remove,
  sync: sync,
  completeSync: completeSync
};
