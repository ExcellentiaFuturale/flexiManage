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
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const {
  prepareTunnelRemoveJob,
  prepareTunnelAddJob,
  queueTunnel
} = require('../deviceLogic/tunnels');
const { validateModifyDeviceMsg } = require('./validators');
const tunnelsModel = require('../models/tunnels');
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const has = require('lodash/has');
const omit = require('lodash/omit');
const differenceWith = require('lodash/differenceWith');
const pullAllWith = require('lodash/pullAllWith');
const isEqual = require('lodash/isEqual');
/**
 * Remove fields that should not be sent to the device from the interfaces array.
 * @param  {Array} interfaces an array of interfaces that will be sent to the device
 * @return {Array}            the same array after removing unnecessary fields
 */
const prepareIfcParams = (interfaces) => {
  return interfaces.map(ifc => {
    const newIfc = omit(ifc, ['_id', 'PublicIP', 'isAssigned', 'pathlabels']);
    newIfc.multilink = {
      labels: ifc.pathlabels
    };
    return newIfc;
  });
};
/**
 * Queues a modify-device job to the device queue.
 * @param  {string}  org                   the organization to which the user belongs
 * @param  {string}  user                  the user that requested the job
 * @param  {Array}   tasks                 the message to be sent to the device
 * @param  {Object}  device                the device to which the job should be queued
 * @param  {Array}   removedTunnelsList=[] tunnels that have been removed as part of
 *                                         the device modification
 * @return {Promise}                       a promise for queuing a job
 */
const queueJob = async (org, user, tasks, device, removedTunnelsList = []) => {
  const job = await deviceQueues.addJob(
    device.machineId, user, org,
    // Data
    { title: `Modify device ${device.hostname}`, tasks: tasks },
    // Response data
    {
      method: 'modify',
      data: {
        device: device._id,
        org: org,
        user: user,
        origDevice: device,
        tunnels: removedTunnelsList
      }
    },
    // Metadata
    { priority: 'medium', attempts: 2, removeOnComplete: false },
    // Complete callback
    null
  );

  logger.info('Modify device job queued', { params: { job: job } });
  return job;
};
/**
 * Performs required tasks before device modification
 * can take place. It removes all tunnels connected to
 * the modified interfaces and then queues the modify device job.
 * @param  {Object}  device        original device object, before the changes
 * @param  {Object}  messageParams device changes that will be sent to the device
 * @param  {string}  user          the user that created the request
 * @param  {string}  org           organization to which the user belongs
 * @return {Job}                   The queued modify-device job
 */
const queueModifyDeviceJob = async (device, messageParams, user, org) => {
  const removedTunnels = [];
  const interfacesIdsSet = new Set();
  const modifiedIfcsSet = new Set();
  messageParams.reconnect = false;

  // Changes in the interfaces require reconstruction of all tunnels
  // connected to these interfaces (since the tunnels parameters change).
  // Maintain all interfaces that have changed in a set that will
  // be used later to find all the tunnels that should be reconstructed.
  // We use a set, since multiple changes can be done in a single modify-device
  // message, hence the interface might appear in both modify-router and
  // modify-interfaces objects, and we want to remove the tunnel only once.
  if (has(messageParams, 'modify_router')) {
    const { assign, unassign } = messageParams.modify_router;
    (assign || []).forEach(ifc => { interfacesIdsSet.add(ifc._id); });
    (unassign || []).forEach(ifc => { interfacesIdsSet.add(ifc._id); });
  }
  if (has(messageParams, 'modify_interfaces')) {
    const { interfaces } = messageParams.modify_interfaces;
    interfaces.forEach(ifc => {
      interfacesIdsSet.add(ifc._id);
      modifiedIfcsSet.add(ifc._id);
    });
  }

  for (const ifc of interfacesIdsSet) {
    // First, remove all active tunnels connected
    // via this interface, on all relevant devices.
    const tunnels = await tunnelsModel
      .find({
        isActive: true,
        $or: [{ interfaceA: ifc._id }, { interfaceB: ifc._id }]
      })
      .populate('deviceA')
      .populate('deviceB');

    for (const tunnel of tunnels) {
      let { deviceA, deviceB } = tunnel;

      // Since the interface changes have already been updated in the database
      // we have to use the original device for creating the tunnel-remove message.
      if (deviceA._id.toString() === device._id.toString()) deviceA = device;
      else deviceB = device;

      const ifcA = deviceA.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceA.toString();
      });
      const ifcB = deviceB.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceB.toString();
      });

      const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(tunnel.num, ifcA, ifcB);
      await queueTunnel(
        false,
        // eslint-disable-next-line max-len
        `Delete tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`,
        tasksDeviceA,
        tasksDeviceB,
        user,
        org,
        deviceA.machineId,
        deviceB.machineId,
        deviceA._id,
        deviceB._id
      );
      // Maintain a list of all removed tunnels for adding them back
      // after the interface changes are applied on the device.
      // Add the tunnel to this list only if the interface connected
      // to this tunnel has changed any property except for 'isAssigned'
      if (modifiedIfcsSet.has(ifc._id)) removedTunnels.push(tunnel._id);
    }
  }
  // Prepare and queue device modification job
  if (has(messageParams, 'modify_router.assign')) {
    messageParams.modify_router.assign = prepareIfcParams(messageParams.modify_router.assign);
    messageParams.reconnect = true;
  }
  if (has(messageParams, 'modify_router.unassign')) {
    messageParams.modify_router.unassign = prepareIfcParams(messageParams.modify_router.unassign);
    messageParams.reconnect = true;
  }
  if (has(messageParams, 'modify_interfaces')) {
    messageParams.modify_interfaces.interfaces = prepareIfcParams(
      messageParams.modify_interfaces.interfaces
    );
    messageParams.reconnect = true;
  }
  const tasks = [{ entity: 'agent', message: 'modify-device', params: messageParams }];
  const job = await queueJob(org, user, tasks, device, removedTunnels);
  return job;
};
/**
 * Reconstructs tunnels that were removed before
 * sending a modify-device message to a device.
 * @param  {Array}   removedTunnels an array of ids of the removed tunnels
 * @param  {string}  org            the organization to which the tunnels belong
 * @param  {string}  user           the user that requested the device change
 * @return {Promise}                a promise for reconstructing tunnels
 */
const reconstructTunnels = async (removedTunnels, org, user) => {
  const tunnels = await tunnelsModel
    .find({ _id: { $in: removedTunnels }, isActive: true })
    .populate('deviceA')
    .populate('deviceB');

  for (const tunnel of tunnels) {
    const { deviceA, deviceB } = tunnel;
    const ifcA = deviceA.interfaces.find(ifc => {
      return ifc._id.toString() === tunnel.interfaceA.toString();
    });
    const ifcB = deviceB.interfaces.find(ifc => {
      return ifc._id.toString() === tunnel.interfaceB.toString();
    });

    const { agent } = deviceB.versions;
    const [tasksDeviceA, tasksDeviceB] = prepareTunnelAddJob(tunnel.num, ifcA, ifcB, agent);
    await queueTunnel(
      true,
      // eslint-disable-next-line max-len
      `Add tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`,
      tasksDeviceA,
      tasksDeviceB,
      user,
      org,
      deviceA.machineId,
      deviceB.machineId,
      deviceA._id,
      deviceB._id
    );
  }
};
/**
 * Sets the job pending flag value. This flag is used to indicate
 * there's a pending modify-device job in the queue to prevent
 * queuing additional modify-device jobs.
 * @param  {string}  deviceID the id of the device
 * @param  {string}  org      the organization the device belongs to
 * @param  {boolean} flag     the value of the flag
 * @return {Promise}          a promise for updating the flab in the database
 */
const setJobPendingInDB = (deviceID, org, flag) => {
  return devices.update(
    { _id: deviceID, org: org },
    { $set: { pendingDevModification: flag } },
    { upsert: false }
  );
};
/**
 * Reverts the device changes in the database. Since
 * modify-device jobs are sent after the changes had
 * already been updated in the database, the changes
 * must be reverted if the job failed to be sent/
 * processed by the device.
 * @param  {Object}  origDevice device object before changes in the database
 * @return {Promise}            a promise for reverting the changes in the database
 */
const rollBackDeviceChanges = async (origDevice) => {
  const { _id, org } = origDevice;
  const result = await devices.update(
    { _id: _id, org: org },
    {
      $set: {
        defaultRoute: origDevice.defaultRoute,
        interfaces: origDevice.interfaces
      }
    },
    { upsert: false }
  );
  if (result.nModified !== 1) throw new Error('device document was not updated');
};
/**
 * Creates and queues the modify-device job. It compares
 * the current view of the device in the database with
 * the former view to deduce which fields have change.
 * it then creates an object with the changes and calls
 * queueModifyDeviceJob() to queue the job to the device.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (device, user, data) => {
  const userName = user.username;
  const org = user.defaultOrg._id.toString();
  const modifyParams = {};

  // Create the default route modification parameters
  if (device[0].defaultRoute !== data.newDevice.defaultRoute) {
    modifyParams.modify_routes = {
      routes: [{
        addr: 'default',
        old_route: device[0].defaultRoute,
        new_route: data.newDevice.defaultRoute
      }]
    };
  }

  // Create interfaces modification parameters
  // Compare the array of interfaces, and return
  // an array of the interfaces that have changed
  // First, extract only the relevant interface fields
  const [origInterfaces, origIsAssigned] = [
    device[0].interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
        addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
        PublicIP: ifc.PublicIP,
        routing: ifc.routing,
        type: ifc.type,
        isAssigned: ifc.isAssigned,
        pathlabels: ifc.pathlabels
      });
    }),
    device[0].interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        isAssigned: ifc.isAssigned
      });
    })
  ];

  const [newInterfaces, newIsAssigned] = [
    data.newDevice.interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
        addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
        PublicIP: ifc.PublicIP,
        routing: ifc.routing,
        type: ifc.type,
        isAssigned: ifc.isAssigned,
        pathlabels: ifc.pathlabels
      });
    }),

    data.newDevice.interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        isAssigned: ifc.isAssigned
      });
    })
  ];

  // Handle changes in the 'assigned' field. assignedDiff will contain
  // all the interfaces that have changed their 'isAssigned' field
  const assignedDiff = differenceWith(
    newIsAssigned,
    origIsAssigned,
    (origIfc, newIfc) => {
      return isEqual(origIfc, newIfc);
    }
  );

  if (assignedDiff.length > 0) {
    modifyParams.modify_router = {};
    const toAssign = [];
    const toUnAssign = [];
    // Split interfaces into two arrays: one for the interfaces that
    // are about to become assigned, and one for those which will be
    // unassigned. Add the full interface details as well.
    assignedDiff.forEach(ifc => {
      const ifcInfo = newInterfaces.find(ifcEntry => {
        return ifcEntry._id === ifc._id;
      });

      if (ifc.isAssigned) toAssign.push(ifcInfo);
      else toUnAssign.push(ifcInfo);

      // Interfaces that changed their assignment status
      // are not allowed to change. We remove them from
      // the list to avoid change in assignment and modification
      // in the same message.
      pullAllWith(newInterfaces, [ifcInfo], isEqual);
    });
    if (toAssign.length) modifyParams.modify_router.assign = toAssign;
    if (toUnAssign.length) modifyParams.modify_router.unassign = toUnAssign;
  }

  // Handle changes in interface fields other than 'isAssigned'
  let interfacesDiff = differenceWith(
    newInterfaces,
    origInterfaces,
    (origIfc, newIfc) => {
      return isEqual(origIfc, newIfc);
    }
  );

  // Changes made to unassigned interfaces should be
  // stored in the MGMT, but should not reach the device.
  interfacesDiff = interfacesDiff.filter(ifc => {
    return ifc.isAssigned === true;
  });
  if (interfacesDiff.length > 0) {
    modifyParams.modify_interfaces = {};
    modifyParams.modify_interfaces.interfaces = interfacesDiff;
  }

  const modified =
            has(modifyParams, 'modify_routes') ||
            has(modifyParams, 'modify_router') ||
            has(modifyParams, 'modify_interfaces');
  try {
    // Queue job only if the device has changed
    if (modified) {
      // First, go over assigned and modified
      // interfaces and make sure they are valid
      const assign = has(modifyParams, 'modify_router.assign')
        ? modifyParams.modify_router.assign
        : [];
      const modified = has(modifyParams, 'modify_interfaces')
        ? modifyParams.modify_interfaces.interfaces
        : [];
      const interfaces = [...assign, ...modified];
      const { valid, err } = validateModifyDeviceMsg(interfaces);
      if (!valid) {
        // Rollback device changes in database and return error
        await rollBackDeviceChanges(device[0]);
        throw (new Error(err));
      }
      await setJobPendingInDB(device[0]._id, org, true);
      await queueModifyDeviceJob(device[0], modifyParams, userName, org);
    }
  } catch (err) {
    logger.error('Failed to queue modify device job', {
      params: { err: err.message, device: device[0]._id }
    });
    try {
      await setJobPendingInDB(device[0]._id, org, false);
    } catch (err) {
      logger.error('Failed to set job pending flag in db', {
        params: { err: err.message, device: device[0]._id }
      });
    }
    throw (new Error('Internal server error'));
  }
};

/**
 * Called when modify device job completed.
 * In charge of reconstructing the tunnels.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const complete = async (jobId, res) => {
  if (!res) {
    logger.warn('Got an invalid job result', { params: { res: res, jobId: jobId } });
    return;
  }
  logger.info('Device modification complete', { params: { result: res, jobId: jobId } });
  try {
    await reconstructTunnels(res.tunnels, res.org, res.user);
  } catch (err) {
    logger.error('Tunnel reconstruction failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
  try {
    await setJobPendingInDB(res.device, res.org, false);
  } catch (err) {
    logger.error('Failed to set job pending flag in db', {
      params: { err: err.message, jobId: jobId, res: res }
    });
  }
};

/**
 * Called when modify device job fails and
 * reverts the changes in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const error = async (jobId, res) => {
  if (!res || !res.origDevice) {
    logger.warn('Got an invalid job result', { params: { res: res, jobId: jobId } });
    return;
  }
  logger.warn('Rolling back device changes', { params: { jobId: jobId, res: res } });
  try {
    // First rollback changes and only then reconstruct the tunnels. This is
    // done to make sure tunnels are reconstructed with the previous values.
    await rollBackDeviceChanges(res.origDevice);
    await reconstructTunnels(res.tunnels, res.org, res.user);
  } catch (err) {
    logger.error('Device change rollback failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
  try {
    await setJobPendingInDB(res.device, res.org, false);
  } catch (err) {
    logger.error('Failed to set job pending flag in db', {
      params: { err: err.message, jobId: jobId, res: res }
    });
  }
};

/**
 * Called when modify-device job is removed either
 * by user or due to expiration. This method should run
 * only for tasks that were deleted before completion/failure
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  // We rollback changes only for pending jobs, as non-pending
  // jobs are covered by the complete/error callbacks
  if (['inactive', 'delayed', 'active'].includes(job._state)) {
    logger.info('Rolling back device changes for removed task', { params: { job: job } });
    const { org, user, origDevice, tunnels } = job.data.response.data;
    try {
      // First rollback changes and only then reconstruct the tunnels. This is
      // done to make sure tunnels are reconstructed with the previous values.
      await rollBackDeviceChanges(origDevice);
      await reconstructTunnels(tunnels, org, user);
    } catch (err) {
      logger.error('Device change rollback failed', {
        params: { job: job, err: err.message }
      });
    }
    try {
      await setJobPendingInDB(origDevice, org, false);
    } catch (err) {
      logger.error('Failed to set job pending flag in db', {
        params: { err: err.message, job: job }
      });
    }
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error,
  remove: remove
};
