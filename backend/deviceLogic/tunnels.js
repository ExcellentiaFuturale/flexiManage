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

// Logic to apply tunnels between devices
const configs = require('../configs')();
const orgModel = require('../models/organizations');
const tunnelsModel = require('../models/tunnels');
const tunnelIDsModel = require('../models/tunnelids');
const devicesModel = require('../models/devices').devices;
const mongoose = require('mongoose');
const { generateTunnelParams, generateRandomKeys } = require('../utils/tunnelUtils');
const { validateIKEv2 } = require('./IKEv2');

const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const { routerVersionsCompatible, getMajorVersion } = require('../versioning');
const peersModel = require('../models/peers');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });

const intersectIfcLabels = (ifcLabelsA, ifcLabelsB) => {
  const intersection = [];
  ifcLabelsA.forEach(label => {
    if (label && ifcLabelsB.has(label)) intersection.push(label);
  });

  return intersection;
};

/**
 * This function handles create tunnels operations and returns an array of jobs.
 * @async
 * @param  {string}   org  organization ID
 * @param  {string}   user user id of the requesting user
 * @param  {array}    opDevices array of selected devices
 * @param  {array}    pathLabels array of selected path labels
 * @param  {set}      reasons reference to Set of reasons
 * @return {array}    A promises array of tunnels creations
 */
const handleTunnels = async (org, userName, opDevices, pathLabels, reasons) => {
  const devicesLen = opDevices.length;
  const tasks = [];

  const { encryptionMethod } = await orgModel.findOne({ _id: org });
  // for now only 'none', 'ikev2' and 'psk' key exchange methods are supported
  if (!['none', 'ikev2', 'psk'].includes(encryptionMethod)) {
    logger.error('Tunnel creation failed',
      { params: { reason: 'Not supported key exchange method', encryptionMethod } }
    );
    throw new Error('Not supported key exchange method');
  }

  for (let idxA = 0; idxA < devicesLen - 1; idxA++) {
    for (let idxB = idxA + 1; idxB < devicesLen; idxB++) {
      const deviceA = opDevices[idxA];
      const deviceB = opDevices[idxB];

      // Tunnels are supported only between devices of the same router version
      const [verA, verB] = [deviceA.versions.router, deviceB.versions.router];
      if (!routerVersionsCompatible(verA, verB)) {
        logger.warn('Tunnel creation failed', {
          params: { reason: 'Router version mismatch', versions: { verA: verA, verB: verB } }
        });
        reasons.add('Router version mismatch for some devices.');
        continue;
      }

      // only devices with version of agent >= 4
      // are supported for creating tunnels with none encryption method
      if (encryptionMethod === 'none') {
        let noneEncryptionValidated = true;
        for (const device of [deviceA, deviceB]) {
          const majorAgentVersion = getMajorVersion(device.versions.agent);
          if (majorAgentVersion < 4) {
            const reason = 'None encryption method not supported';
            logger.warn('Tunnel creation failed', {
              params: { reason, machineId: device.machineId }
            });
            reasons.add(`${reason} on some of devices.`);
            noneEncryptionValidated = false;
          }
        }
        if (!noneEncryptionValidated) {
          continue;
        }
      }

      // only devices with version of agent >= 4 and valid certificates
      // are supported for creating tunnels with IKEv2 key exchange method
      if (encryptionMethod === 'ikev2') {
        let ikev2Validated = true;
        for (const device of [deviceA, deviceB]) {
          const { valid, reason } = validateIKEv2(device);
          if (!valid) {
            logger.warn('Tunnel creation failed', {
              params: { reason, machineId: device.machineId }
            });
            reasons.add(`${reason} on some of devices.`);
            ikev2Validated = false;
          }
        }
        if (!ikev2Validated) {
          continue;
        }
      }

      // Create the list of interfaces for both devices.
      // Add a set of the interface's path labels
      const deviceAIntfs = getInterfacesWithPathLabels(deviceA);
      const deviceBIntfs = getInterfacesWithPathLabels(deviceB);

      const devicesInfo = {
        deviceA: { hostname: deviceA.hostname, interfaces: deviceAIntfs },
        deviceB: { hostname: deviceB.hostname, interfaces: deviceBIntfs }
      };
      logger.debug('Connecting tunnel between devices', { params: { devicesInfo } });

      // Create a tunnel between each WAN interface on device A to
      // each of the WAN interfaces on device B according to the path
      // labels assigned to the interfaces. If the list of path labels
      // IDs contains the ID 'FFFFFF', create tunnels between all common
      // path labels across all WAN interfaces.
      // TBD: key exchange should be dynamic
      const specifiedLabels = new Set(pathLabels);
      const createForAllLabels = specifiedLabels.has('FFFFFF');
      if (deviceAIntfs.length && deviceBIntfs.length) {
        for (let idxA = 0; idxA < deviceAIntfs.length; idxA++) {
          for (let idxB = 0; idxB < deviceBIntfs.length; idxB++) {
            const wanIfcA = deviceAIntfs[idxA];
            const wanIfcB = deviceBIntfs[idxB];
            const ifcALabels = wanIfcA.labelsSet;
            const ifcBLabels = wanIfcB.labelsSet;

            // If no path labels were selected, create a tunnel
            // only if both interfaces aren't assigned with labels
            if (specifiedLabels.size === 0) {
              if (ifcALabels.size === 0 && ifcBLabels.size === 0) {
                // If a tunnel already exists, skip the configuration
                const tunnelFound = await getTunnel(org, null, wanIfcA, wanIfcB);
                if (tunnelFound.length > 0) {
                  logger.debug('Found tunnel', {
                    params: { tunnel: tunnelFound }
                  });
                  reasons.add('Some tunnels exist already.');
                } else {
                  tasks.push(generateTunnelPromise(userName, org, null,
                    { ...deviceA.toObject() }, { ...deviceB.toObject() },
                    { ...wanIfcA }, { ...wanIfcB }, encryptionMethod));
                }
              } else {
                reasons.add(
                  'No Path Labels specified but some devices have interfaces with Path Labels.'
                );
              }
            } else {
              // Create a list of path labels that are common to both interfaces.
              const labelsIntersection = intersectIfcLabels(ifcALabels, ifcBLabels);
              if (labelsIntersection.length === 0) {
                reasons.add('Some devices have interfaces without specified Path Labels.');
              }
              for (const label of labelsIntersection) {
                // Skip tunnel if the label is not included in
                // the list of labels specified by the user
                const shouldSkipTunnel =
                  !createForAllLabels &&
                  !specifiedLabels.has(label);
                if (shouldSkipTunnel) {
                  reasons.add('Some devices have interfaces without specified Path Labels.');
                  continue;
                }
                // If a tunnel already exists, skip the configuration
                const tunnelFound = await getTunnel(org, label, wanIfcA, wanIfcB);
                if (tunnelFound.length > 0) {
                  logger.debug('Found tunnel', {
                    params: { tunnel: tunnelFound }
                  });
                  reasons.add('Some tunnels exist already.');
                  continue;
                }
                // Use a copy of devices objects as promise runs later
                tasks.push(generateTunnelPromise(userName, org, label,
                  { ...deviceA.toObject() }, { ...deviceB.toObject() },
                  { ...wanIfcA }, { ...wanIfcB }, encryptionMethod));
              }
            }
          };
        };
      } else {
        logger.info('Failed to connect tunnel between devices', {
          params: {
            deviceA: deviceA.hostname,
            deviceB: deviceB.hostname,
            reason: 'no valid WAN interfaces'
          }
        });
        reasons.add('Some devices have no valid WAN interfaces.');
      }
    }
  }

  return tasks;
};

/**
 * This function handles create peers operations and returns an array of jobs.
 * @async
 * @param  {string}   org  organization ID
 * @param  {string}   user user id of the requesting user
 * @param  {array}    opDevices array of selected devices
 * @param  {array}    pathLabels array of selected path labels
 * @param  {array}    peersIds array of peers ids
 * @param  {set}      reasons reference to Set of reasons
 * @return {array}    A promises array of tunnels creations
 */
const handlePeers = async (org, userName, opDevices, pathLabels, peersIds, reasons) => {
  const tasks = [];

  // get peers configurations
  const peers = await peersModel.find({ _id: { $in: peersIds }, org: org }).lean();

  for (const device of opDevices) {
    // peer is supported for major version 5
    // const majorAgentVersion = getMajorVersion(device.versions.agent);
    // if (majorAgentVersion < 5) {
    //   reasons.add('Peer tunnel is not supported on some of devices');
    //   continue;
    // };

    // Create the list of interfaces for the device.
    // Add a set of the interface's path labels
    const deviceIntfs = getInterfacesWithPathLabels(device);
    logger.debug('Peer device info', { params: { deviceIntfs } });

    if (deviceIntfs.length === 0) {
      logger.info('Failed to create peer for device', {
        params: {
          device: device.hostname,
          reason: 'no valid WAN interfaces'
        }
      });
      reasons.add('Some devices have no valid WAN interfaces.');
      continue;
    }

    // Create a peer for each WAN interface of the device according to the path
    // labels assigned to the interfaces. If the list of path labels
    // IDs contains the ID 'FFFFFF', create peers between all common
    // path labels across all WAN interfaces.
    const specifiedLabels = new Set(pathLabels);
    const createForAllLabels = specifiedLabels.has('FFFFFF');
    for (const wanIfc of deviceIntfs) {
      const ifcLabels = wanIfc.labelsSet;

      // If no path labels were specified by user,
      // but interface has path labels, we don't create for peer for this interface.
      if (specifiedLabels.size === 0) {
        // If the WAN interface has path labels, we skip the creation for this interface
        if (ifcLabels.size > 0) {
          const reason =
            `Paths labels were not specified -
            The system didn't configure interfaces with path labels.`;
          logger.info('Skip creation peer for interface', {
            params: { device: device.hostname, interface: wanIfc.name, reason }
          });
          reasons.add(reason);
          continue;
        }

        // Create peer configuration for the interface
        for (const peer of peers) {
          // If the peer already exists, skip the configuration
          const peerFound = await getTunnel(org, null, wanIfc, null, peer._id);
          if (peerFound.length > 0) {
            logger.debug('Found existing peer', { params: { peer: peerFound } });
            reasons.add('Some peers exist already.');
            continue;
          }

          // generate peer configuration job
          const promise = generateTunnelPromise(userName, org, null, device,
            null, wanIfc, null, 'ikev2', peer);
          tasks.push(promise);
        }
      } else {
        // If interface has more than one path label, we can't create peer for each one
        if (ifcLabels.size > 1) {
          let allLabelsSelected = createForAllLabels;
          if (!allLabelsSelected) {
            allLabelsSelected = ifcLabels.size === specifiedLabels.size;
          }

          if (allLabelsSelected) {
            logger.debug('Interface has more than one path label.',
              {
                params: {
                  ifcLabels,
                  wanIfc
                }
              });
            reasons.add('The system skipped interfaces that have multiple path labels.');
            continue;
          }
        }

        for (const label of ifcLabels) {
          const shouldSkipPeer = !createForAllLabels && !specifiedLabels.has(label);
          if (shouldSkipPeer) {
            reasons.add('Some devices have interfaces without the specified Path Labels.');
            continue;
          }

          for (const peer of peers) {
            const peerFound = await getTunnel(org, label, wanIfc, null, peer._id);
            if (peerFound.length > 0) {
              logger.debug('Found existing peer with this path label',
                { params: { peer: peerFound, label: label } });
              reasons.add('Some tunnels exist already.');
              continue;
            }

            // generate peer configuration job
            const promise = generateTunnelPromise(
              userName, org, label, device, null, wanIfc, null, 'ikev2', peer);
            tasks.push(promise);
          }
        }
      }
    }
  }

  return tasks;
};

/**
 * This function is called when adding new tunnels
 * @async
 * @param  {Array}    devices   an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const applyTunnelAdd = async (devices, user, data) => {
  /**
     * Request body holds the list of devices ids to connect tunnel between
     */
  const selectedDevices = data.devices;
  logger.info('Creating tunnels between devices', {
    params: { devices: selectedDevices }
  });

  // Get details for devices to connect
  const opDevices = (devices && selectedDevices)
    ? devices.filter((device) => {
      const inSelected = selectedDevices.hasOwnProperty(device._id);
      if (inSelected) return true;
      else return false;
    }) : [];

  const isPeer = data.tunnelType === 'peer';
  if (isPeer && (!data.peers || !Array.isArray(data.peers) || data.peers.length === 0)) {
    throw new Error('Peers identifiers were not specified');
  }

  // For a site-to-site tunnel we only allow more than two devices
  if (!isPeer && opDevices.length < 2) {
    logger.error('At least 2 devices must be selected to create tunnels', { params: {} });
    throw new Error('At least 2 devices must be selected to create tunnels');
  }

  let dbTasks = [];
  const userName = user.username;
  const org = data.org;

  // array of common reasons of not created tunnels for some devices
  // used to build a response message
  const reasons = new Set(); // unique messages array

  if (isPeer) {
    const tasks = await handlePeers(
      org, userName, opDevices, data.meta.pathLabels, data.peers, reasons);
    dbTasks = dbTasks.concat(tasks);
  } else {
    const tasks = await handleTunnels(
      org, userName, opDevices, data.meta.pathLabels, reasons);
    dbTasks = dbTasks.concat(tasks);
  }

  // Execute all promises
  logger.debug('Running tunnel promises', { params: { tunnels: dbTasks.length } });

  const promiseStatus = await Promise.allSettled(dbTasks);
  const fulfilled = promiseStatus.reduce((arr, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      arr.push(job);
    }
    return arr;
  }, []);

  const status = fulfilled.length < dbTasks.length
    ? 'partially completed' : 'completed';

  const desired = dbTasks.flat().map(job => job.id);
  const ids = fulfilled.flat().map(job => job.id);
  let message = `${isPeer ? 'peer ' : ''}tunnels creation jobs added.`;
  if (desired.length === 0) {
    message = 'No ' + message;
  } else if (ids.length < desired.length) {
    message = `${ids.length} of ${desired.length} ${message}`;
  } else {
    message = `${ids.length} ${message}`;
  }
  if (reasons.size > 0) {
    message = `${message} ${Array.from(reasons).join(' ')}`;
  }
  return { ids, status, message };
};

/**
 * Complete tunnel add, called for each of the
 * devices that are connected by the tunnel.
 * @param  {number} jobId Kue job ID
 * @param  {Object} res   including the deviceA id, deviceB id, deviceSideConf
 * @return {void}
 */
const completeTunnelAdd = (jobId, res) => {
  if (!res || !res.tunnelId || !res.target || !res.username || !res.org) {
    logger.warn('Got an invalid job result', { params: { result: res, jobId: jobId } });
    return;
  }

  updateTunnelIsConnected(tunnelsModel, res.org,
    res.tunnelId, res.target, true)(null, (err, res) => {
    if (err) {
      logger.error('Update tunnel connectivity failed', {
        params: { jobId: jobId, reason: err.message }
      });
    }
  }
  );
};

/**
 * Complete handler for sync job
 * @return void
 */
const completeSync = async (jobId, jobsData) => {
  try {
    for (const data of jobsData) {
      await completeTunnelAdd(jobId, data);
    }
  } catch (err) {
    logger.error('Tunnels sync complete callback failed', {
      params: { jobsData, reason: err.message }
    });
  }
};

/**
 * Error tunnel add, called for each of the
 * devices that are connected by the tunnel.
 * @param  {number} jobId Kue job ID
 * @param  {Object} res   including the deviceA id, deviceB id, deviceSideConf
 * @return {void}
 */
const errorTunnelAdd = async (jobId, res) => {
  logger.info('Tunnel add error.',
    { params: { result: res, jobId: jobId } });
  if (!res || !res.deviceA || !res.deviceB || !res.target || !res.username || !res.org) {
    logger.warn('Got an invalid job result', { params: { result: res, jobId: jobId } });
  }
};

/**
 * Returns an active tunnel object promise from DB
 * @param  {string}   org         organization id the user belongs to
 * @param  {string}   pathLabel   path label id
 * @param  {Object}   wanIfcA     device A tunnel interface
 * @param  {Object?}  wanIfcB     device B tunnel interface
 * @param  {string?}  peerId      peerId
 */
const getTunnel = (org, pathLabel, wanIfcA, wanIfcB, peerId = false) => {
  const query = {
    isActive: true,
    pathlabel: pathLabel,
    org: org
  };

  // peers are not configured with deviceB and interfaceB
  if (!peerId) {
    query.$or = [
      { interfaceA: wanIfcA._id, interfaceB: wanIfcB._id },
      { interfaceB: wanIfcA._id, interfaceA: wanIfcB._id }
    ];
  } else {
    query.interfaceA = wanIfcA._id;
    query.peer = peerId;
  }

  return tunnelsModel.find(query);
};

/**
 * This function generates one tunnel promise including
 * all configurations for the tunnel into the device
 * @param  {string}   user         user id of the requesting user
 * @param  {string}   org          organization id the user belongs to
 * @param  {string}   pathLabel    path label
 * @param  {Object}   deviceA      device A details
 * @param  {Object?}  deviceB      device B details
 * @param  {Object}   deviceAIntf  device A tunnel interface
 * @param  {Object?}  deviceBIntf  device B tunnel interface
 * @param  {string}   encryptionMethod key exchange method [none|ikev2|psk]
 * @param  {boolean}  peer         peer configurations
 */
const generateTunnelPromise = (user, org, pathLabel, deviceA, deviceB,
  deviceAIntf, deviceBIntf, encryptionMethod = null, peer = null) => {
  logger.debug(`Adding tunnel${peer ? '' : ' between devices'}`, {
    params: {
      deviceA: deviceA.hostname,
      deviceB: peer ? null : deviceB.hostname,
      interfaces: {
        interfaceA: deviceAIntf.name,
        interfaceB: peer ? null : deviceBIntf.name
      },
      label: pathLabel,
      encryptionMethod: encryptionMethod,
      peer
    }
  });

  var tPromise = new Promise(function (resolve, reject) {
    // Check if tunnel can be created
    // Get a unique tunnel number
    // Search first in deleted tunnels
    tunnelsModel.findOneAndUpdate(
      // Query
      { isActive: false, org: org },
      // Update, make sure other query doesn't find the same number
      { isActive: true },
      // Options
      { upsert: false }
    )
      .then(async (tunnelResp) => {
        logger.debug('Found a tunnel', { params: { tunnel: tunnelResp } });

        if (tunnelResp !== null) { // deleted tunnel found, use it
          const tunnelnum = tunnelResp.num;
          logger.info('Adding tunnel from deleted tunnel', { params: { tunnel: tunnelnum } });

          // Configure tunnel using this num
          const tunnelJobs = await addTunnel(user, org, tunnelnum, encryptionMethod,
            deviceA, deviceB, deviceAIntf, deviceBIntf, pathLabel, peer);

          return resolve(tunnelJobs);
        } else { // No deleted tunnel found, get a new one
          tunnelIDsModel.findOneAndUpdate(
            // Query, allow only 15000 tunnels per organization
            {
              org: org,
              nextAvailID: { $gte: 0, $lt: 15000 }
            },
            // Update
            { $inc: { nextAvailID: 1 } },
            // Options
            { new: true, upsert: true }
          ).then(async (idResp) => {
            const tunnelnum = idResp.nextAvailID;
            logger.info('Adding tunnel with new ID', { params: { tunnel: tunnelnum } });

            // Configure tunnel using this num
            const tunnelJobs = await addTunnel(user, org, tunnelnum, encryptionMethod,
              deviceA, deviceB, deviceAIntf, deviceBIntf, pathLabel, peer);

            return resolve(tunnelJobs);
          }, (err) => {
            // org is a key value in the collection, upsert sometimes creates a new doc
            // (if two upserts done at once)
            // In this case we need to check the error and try again if such occurred
            // See more info in:
            // eslint-disable-next-line max-len
            // https://stackoverflow.com/questions/37295648/mongoose-duplicate-key-error-with-upsert
            if (err.code === 11000) {
              logger.debug('2nd try to find tunnel ID', { params: {} });
              tunnelIDsModel.findOneAndUpdate(
                // Query, allow only 15000 tunnels per organization
                {
                  org: org,
                  nextAvailID: { $gte: 0, $lt: 15000 }
                },
                // Update
                { $inc: { nextAvailID: 1 } },
                // Options
                { new: true, upsert: true }
              ).then(async (idResp) => {
                const tunnelnum = idResp.nextAvailID;
                logger.info('Adding tunnel with new ID', { params: { tunnel: tunnelnum } });
                // Configure tunnel using this num
                const tunnelJobs = await addTunnel(user, org, tunnelnum, encryptionMethod,
                  deviceA, deviceB, deviceAIntf, deviceBIntf, pathLabel, peer);

                return resolve(tunnelJobs);
              }, (err) => {
                logger.error('Tunnel ID not found (not found twice)', {
                  params: { reason: err.message }
                });
                reject(new Error('Tunnel ID not found'));
              });
            } else {
              // Another error
              logger.error('Tunnel ID not found (other error)', {
                params: { reason: err.message }
              });
              reject(new Error('Tunnel ID not found'));
            }
          })
            .catch((err) => {
              logger.error('Tunnel ID not found (general error)', {
                params: { reason: err.message }
              });
              reject(new Error('Tunnel ID not found'));
            });
        }
      }, (err) => {
        logger.error('Tunnels search error', { params: { reason: err.message } });
        reject(new Error('Tunnels search error'));
      })
      .catch((err) => {
        logger.error('Tunnels search error (general error)', {
          params: { reason: err.message }
        });
        reject(new Error('Tunnel ID not found'));
      });
  });
  return tPromise;
};

/**
 * Queues the tunnel creation/deletion jobs to both
 * of the devices that are connected via the tunnel
 * @param  {boolean} isAdd        a flag indicating creation/deletion
 * @param  {string} title         title of the task
 * @param  {Object} tasksDeviceA  device A tunnel job
 * @param  {Object} tasksDeviceB  device B tunnel job
 * @param  {string} user          user id of the requesting user
 * @param  {string} org           user's organization id
 * @param  {string} devAMachineID device A host id
 * @param  {string?} devBMachineID device B host id
 * @param  {string} devAOid       device A database mongodb object id
 * @param  {string?} devBOid      device B database mongodb object id
 * @param  {string} tunnelId      tunnel number
 * @param  {string} pathLabel     pathLabel
 * @param  {object?} peer         peer configurations
 * @return {void}
 */
const queueTunnel = async (
  isAdd,
  title,
  tasksDeviceA,
  tasksDeviceB,
  user,
  org,
  devAMachineID,
  devBMachineID,
  devAOid,
  devBOid,
  tunnelId,
  pathLabel,
  peer = null
) => {
  try {
    const devices = { deviceA: devAOid, deviceB: devBOid };
    const jobA = await deviceQueues.addJob(
      devAMachineID,
      user,
      org,
      // Data
      {
        title: title,
        tasks: tasksDeviceA
      },
      // Response data
      {
        method: isAdd ? 'tunnels' : 'deltunnels',
        data: {
          username: user,
          org: org,
          tunnelId: tunnelId,
          deviceA: devAOid,
          deviceB: devBOid,
          pathlabel: pathLabel,
          target: 'deviceAconf',
          peer
        }
      },
      // Metadata
      { priority: 'normal', attempts: 1, removeOnComplete: false },
      // Complete callback
      null
    );

    logger.info(`${isAdd ? 'Add' : 'Del'} tunnel job queued - deviceA`, {
      params: { devices: devices },
      job: jobA
    });

    const jobB = peer ? null : await deviceQueues.addJob(
      devBMachineID,
      user,
      org,
      // Data
      {
        title: title,
        tasks: tasksDeviceB
      },
      // Response data
      {
        method: isAdd ? 'tunnels' : 'deltunnels',
        data: {
          username: user,
          org: org,
          tunnelId: tunnelId,
          deviceA: devAOid,
          deviceB: devBOid,
          pathlabel: pathLabel,
          target: 'deviceBconf'
        }
      },
      // Metadata
      { priority: 'normal', attempts: 1, removeOnComplete: false },
      // Complete callback
      null
    );

    logger.info(`${isAdd ? 'Add' : 'Del'} tunnel job queued - deviceB`, {
      params: { devices: devices },
      job: jobB
    });

    const res = [jobA];
    if (jobB) res.push(jobB);
    return res;
  } catch (err) {
    logger.error('Error queuing tunnel', {
      params: { deviceAId: devAMachineID, deviceBId: devBMachineID, message: err.message }
    });
    if (peer) {
      throw new Error(
        `Error queuing peer tunnel for device ID ${devAMachineID} and peer ${peer.name}`);
    } else {
      throw new Error(`Error queuing tunnel for device IDs ${devAMachineID} and ${devBMachineID}`);
    }
  }
};

/**
 * Prepares tunnel add jobs by creating an array that contains
 * the jobs that should be queued for each of the devices connected
 * by the tunnel.
 * @param  {Object} tunnel    tunnel object
 * @param  {Object} deviceAIntf device A tunnel interface
 * @param  {Object?} deviceBIntf device B tunnel interface
 * @param  {pathLabel} path label used for this tunnel
 * @param  {Object} deviceA details of device A
 * @param  {Object?} deviceB details of device B
 * @param  {Object?}  peer peer configurations
 * @return {[{entity: string, message: string, params: Object}]} an array of tunnel-add jobs
 */
const prepareTunnelAddJob = async (
  tunnel,
  deviceAIntf,
  deviceBIntf,
  pathLabel,
  deviceA,
  deviceB,
  peer = null
) => {
  // Extract tunnel keys from the database
  if (!tunnel) throw new Error('Tunnel not found');

  const tasksDeviceA = [];
  const tasksDeviceB = [];

  const {
    paramsDeviceA,
    paramsDeviceB,
    tunnelParams
  } = prepareTunnelParams(
    tunnel,
    deviceAIntf,
    deviceBIntf,
    pathLabel,
    peer
  );

  const validateParams = [paramsDeviceA];
  if (!peer) validateParams.push(paramsDeviceB);
  validateParams.forEach(({ src, dst, dstPort }, idx) => {
    if (!src) {
      throw new Error('Source IP address is empty');
    }
    if (!dst) {
      throw new Error('Destination IP address is empty');
    }
    if (!dstPort && !peer) {
      throw new Error('Destination port is empty');
    }
  });

  if (tunnel.encryptionMethod === 'ikev2') {
    // construct IKEv2 tunnel
    paramsDeviceA.ikev2 = {
      role: 'initiator',
      'remote-device-id': peer ? peer.remoteFQDN : deviceB.machineId,
      lifetime: configs.get('ikev2Lifetime', 'number'),
      ike: {
        'crypto-alg': 'aes-cbc',
        'integ-alg': 'hmac-sha2-256-128',
        'dh-group': 'modp-2048',
        'key-size': 256
      },
      esp: {
        'crypto-alg': 'aes-cbc',
        'integ-alg': 'hmac-sha2-256-128',
        'dh-group': 'ecp-256',
        'key-size': 256
      },
      certificate: peer ? null : deviceB.IKEv2.certificate
    };

    // for peers - we use psk with ikev2
    if (peer) {
      paramsDeviceA.ikev2['local-device-id'] = peer.localFQDN;
      paramsDeviceA.ikev2.mode = 'psk';
      paramsDeviceA.ikev2.psk = peer.psk;
      delete paramsDeviceA.ikev2.certificate;
    } else {
      // no need to fill ikev2 for deviceB for peer
      paramsDeviceB.ikev2 = {
        role: 'responder',
        'remote-device-id': deviceA.machineId,
        certificate: deviceA.IKEv2.certificate
      };
    }
  } else if (tunnel.encryptionMethod === 'psk') {
    // construct static ipsec tunnel
    if (!tunnel.tunnelKeys) {
      // Generate new IPsec Keys and store them in the database
      const { key1, key2, key3, key4 } = generateRandomKeys();
      try {
        await tunnelsModel.findOneAndUpdate(
          { _id: tunnel._id },
          { tunnelKeys: { key1, key2, key3, key4 } },
          { upsert: false }
        );
        tunnel.tunnelKeys = { key1, key2, key3, key4 };
        logger.warn('New tunnel keys generated', {
          params: { tunnelId: tunnel._id }
        });
      } catch (err) {
        logger.error('Failed to set new tunnel keys', {
          params: { tunnelId: tunnel._id, err: err.message }
        });
      }
    }
    const tunnelKeys = {
      key1: tunnel.tunnelKeys.key1,
      key2: tunnel.tunnelKeys.key2,
      key3: tunnel.tunnelKeys.key3,
      key4: tunnel.tunnelKeys.key4
    };

    const paramsIpsecDeviceA = {};
    const paramsIpsecDeviceB = {};
    const paramsSaAB = {
      spi: tunnelParams.sa1,
      'crypto-key': tunnelKeys.key1,
      'integr-key': tunnelKeys.key2,
      'crypto-alg': 'aes-cbc-128',
      'integr-alg': 'sha-256-128'
    };
    const paramsSaBA = {
      spi: tunnelParams.sa2,
      'crypto-key': tunnelKeys.key3,
      'integr-key': tunnelKeys.key4,
      'crypto-alg': 'aes-cbc-128',
      'integr-alg': 'sha-256-128'
    };
    paramsIpsecDeviceA['local-sa'] = paramsSaAB;
    paramsIpsecDeviceA['remote-sa'] = paramsSaBA;
    paramsDeviceA.ipsec = paramsIpsecDeviceA;

    const majorAgentBVersion = getMajorVersion(deviceB.versions.agent);

    if (majorAgentBVersion < 4) { // version 1-3.X.X
      // The following looks as a wrong config in vpp 19.01 ipsec-gre interface,
      // spi isn't configured properly for SA
      paramsIpsecDeviceB['local-sa'] = { ...paramsSaAB, spi: tunnelParams.sa2 };
      paramsIpsecDeviceB['remote-sa'] = { ...paramsSaBA, spi: tunnelParams.sa1 };
    } else if (majorAgentBVersion >= 4) { // version 4.X.X+
      paramsIpsecDeviceB['local-sa'] = { ...paramsSaBA };
      paramsIpsecDeviceB['remote-sa'] = { ...paramsSaAB };
    }
    paramsDeviceB.ipsec = paramsIpsecDeviceB;
  }

  // Saving configuration for device A
  tasksDeviceA.push({
    entity: 'agent',
    message: 'add-tunnel',
    params: paramsDeviceA
  });

  if (!peer) {
    // Saving configuration for device B
    tasksDeviceB.push({
      entity: 'agent',
      message: 'add-tunnel',
      params: paramsDeviceB
    });
  }

  return [tasksDeviceA, tasksDeviceB];
};

/**
 * Calls the necessary APIs for creating a single tunnel
 * @param  {string}   user         user id of requesting user
 * @param  {string}   org          id of the organization of the user
 * @param  {number}   tunnelnum    id of the tunnel to be added
 * @param  {string}   encryptionMethod key exchange method [none|ikev2|psk]
 * @param  {Object}   deviceA      details of device A
 * @param  {Object?}  deviceB      details of device B
 * @param  {Object}   deviceAIntf  device A tunnel interface
 * @param  {Object?}  deviceBIntf  device B tunnel interface
 * @param  {Object?}  peer         peer configurations
 * @return {void}
 */
const addTunnel = async (
  user,
  org,
  tunnelnum,
  encryptionMethod,
  deviceA,
  deviceB,
  deviceAIntf,
  deviceBIntf,
  pathLabel,
  peer = null
) => {
  const devicesInfo = {
    deviceA: { hostname: deviceA.hostname, interface: deviceAIntf.name }
  };
  if (!peer) {
    devicesInfo.deviceB = { hostname: deviceB.hostname, interface: deviceBIntf.name };
  }
  logger.info('Adding Tunnel', {
    params: { devices: devicesInfo }
  });

  // Generate IPsec Keys and store them in the database
  const tunnelKeys = encryptionMethod === 'psk' ? generateRandomKeys() : null;

  const tunnel = await tunnelsModel.findOneAndUpdate(
    // Query, use the org and tunnel number
    {
      org: org,
      num: tunnelnum
    },
    // Update
    {
      isActive: true,
      deviceAconf: false,
      deviceBconf: false,
      deviceA: deviceA._id,
      interfaceA: deviceAIntf._id,
      deviceB: peer ? null : deviceB._id,
      interfaceB: peer ? null : deviceBIntf._id,
      pathlabel: pathLabel,
      encryptionMethod,
      tunnelKeys,
      peer: peer ? peer._id : null
    },
    // Options
    { upsert: true, new: true }
  );

  const [tasksDeviceA, tasksDeviceB] = await prepareTunnelAddJob(
    tunnel,
    deviceAIntf,
    deviceBIntf,
    pathLabel,
    deviceA,
    deviceB,
    peer
  );

  let title = '';
  if (peer) {
    title += 'Create peer tunnel between (' +
      deviceA.hostname +
      ',' +
      deviceAIntf.name +
      ') and peer (' +
      peer.name +
      ')';
  } else {
    title += 'Create tunnel between (' +
      deviceA.hostname +
      ',' +
      deviceAIntf.name +
      ') and (' +
      deviceB.hostname +
      ',' +
      deviceBIntf.name +
      ')';
  }
  const tunnelJobs = await queueTunnel(
    true,
    title,
    tasksDeviceA,
    tasksDeviceB,
    user,
    org,
    deviceA.machineId,
    peer ? null : deviceB.machineId,
    deviceA._id,
    peer ? null : deviceB._id,
    tunnelnum,
    pathLabel,
    peer
  );

  return tunnelJobs;
};

/**
 * Update tunnel device configuration
 * @param  {Object}  tunnelsModel mongoose tunnel schema
 * @param  {string}  org          organization initiated the request
 * @param  {string}  tunnelId     the id of the tunnel to update
 * @param  {string}  target       which parameter to update in the model
 * @param  {boolean} isAdd        update to configuration of true or false
 * @return {void}
 */
const updateTunnelIsConnected = (
  tunnelsModel,
  org,
  tunnelId,
  target,
  isAdd
) => (inp, callback) => {
  const params = {
    org: org,
    target: target,
    isAdd: isAdd
  };
  logger.info('Updating tunnels connectivity', { params: params });
  const update = {};
  update[target] = isAdd;

  tunnelsModel
    .findOneAndUpdate(
      // Query
      { num: tunnelId, org: org },
      // Update
      update,
      // Options
      { upsert: false, new: true }
    )
    .then(
      resp => {
        if (resp != null) {
          callback(null, { ok: 1 });
        } else {
          const err = new Error('Update tunnel connected status failure');
          callback(err, false);
        }
      },
      err => {
        callback(err, false);
      }
    )
    .catch(err => {
      callback(err, false);
    });
};

/**
 * This function is called when deleting a tunnel
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const applyTunnelDel = async (devices, user, data) => {
  const selectedTunnels = data.tunnels;
  const tunnelIds = Object.keys(selectedTunnels);
  logger.info('Delete tunnels ', { params: { tunnels: selectedTunnels } });

  if (devices && tunnelIds.length > 0) {
    const org = data.org;
    const userName = user.username;

    const delPromises = [];
    tunnelIds.forEach(tunnelID => {
      try {
        const delPromise = oneTunnelDel(tunnelID, userName, org);
        delPromises.push(delPromise);
      } catch (err) {
        logger.error('Delete tunnel error', { params: { tunnelID, error: err.message } });
      }
    });

    const promiseStatus = await Promise.allSettled(delPromises);
    const { fulfilled, reasons } = promiseStatus.reduce(({ fulfilled, reasons }, elem) => {
      if (elem.status === 'fulfilled') {
        const job = elem.value;
        fulfilled.push(job);
      } else {
        if (!reasons.includes(elem.reason.message)) {
          reasons.push(elem.reason.message);
        }
      };
      return { fulfilled, reasons };
    }, { fulfilled: [], reasons: [] });
    const status = fulfilled.length < tunnelIds.length
      ? 'partially completed' : 'completed';
    const message = fulfilled.length < tunnelIds.length
      ? `${fulfilled.length} of ${tunnelIds.length} tunnels deletion jobs added.
      ${reasons.join('. ')}` : '';
    return { ids: fulfilled.flat().map(job => job.id), status, message };
  } else {
    logger.error('Delete tunnels failed. No tunnels\' ids provided or no devices found',
      { params: { tunnelIds, devices } });
    throw new Error('Delete tunnels failed. No tunnels\' ids provided or no devices found');
  }
};

/**
 * Deletes a single tunnel.
 * @param  {number}   tunnelID   the id of the tunnel to be deleted
 * @param  {string}   user       the user id of the requesting user
 * @param  {string}   org        the user's organization id
 * @return {array}    jobs created
 */
const oneTunnelDel = async (tunnelID, user, org) => {
  const tunnelResp = await tunnelsModel.findOne({ _id: tunnelID, isActive: true, org: org })
    .populate('deviceA')
    .populate('deviceB')
    .populate('peer');

  logger.debug('Delete tunnels db response', { params: { response: tunnelResp } });

  if (!tunnelResp) {
    throw new Error('Tunnel not found');
  };

  // Define devices
  const { num, deviceA, deviceB, pathLabel, peer } = tunnelResp;

  // Check is tunnel used by any static route
  // TODO: check
  const { ip1, ip2 } = generateTunnelParams(num);
  const tunnelUsedByStaticRoute =
    (Array.isArray(deviceA.staticroutes) &&
    deviceA.staticroutes.some(s => [ip1, ip2].includes(s.gateway))) ||
    (!peer && (Array.isArray(deviceB.staticroutes) &&
    deviceB.staticroutes.some(s => [ip1, ip2].includes(s.gateway))));

  if (tunnelUsedByStaticRoute) {
    throw new Error(
      'Some static routes defined via removed tunnel, please remove static routes first'
    );
  };

  // Populate interface details
  const deviceAIntf = tunnelResp.deviceA.interfaces
    .filter((ifc) => { return ifc._id.toString() === '' + tunnelResp.interfaceA; })[0];
  const deviceBIntf = peer ? null : tunnelResp.deviceB.interfaces
    .filter((ifc) => { return ifc._id.toString() === '' + tunnelResp.interfaceB; })[0];

  const tunnelJobs = await delTunnel(user, org, tunnelResp, deviceA, deviceB,
    deviceAIntf, deviceBIntf, pathLabel, peer);

  logger.info('Deleting tunnels from database');
  const resp = await tunnelsModel.findOneAndUpdate(
    // Query
    { _id: mongoose.Types.ObjectId(tunnelID), org: org },
    // Update
    {
      isActive: false,
      deviceAconf: false,
      deviceBconf: false,
      pendingTunnelModification: false,
      tunnelKeys: null
    },
    // Options
    { upsert: false, new: true }
  );

  if (resp === null) throw new Error('Error deleting tunnel');

  return tunnelJobs;
};

/**
 * Called when tunnel delete jobs are finished successfully.
 * @param  {number} jobId the id of the delete tunnel job
 * @param  {Object} res   the result of the delete tunnel job
 * @return {void}
 */
const completeTunnelDel = (jobId, res) => {
};

/**
 * Prepares tunnel delete jobs by creating an array that contains
 * the jobs that should be queued for each of the devices connected
 * by the tunnel.
 * @param  {Object} tunnel      the tunnel object to be deleted
 * @param  {Object} deviceAIntf device A tunnel interface
 * @param  {Object} deviceBIntf device B tunnel interface
 * @param  {Object} peer        peer configurations
 * @return {[{entity: string, message: string, params: Object}]} an array of tunnel-add jobs
 */
const prepareTunnelRemoveJob = (tunnel, deviceAIntf, deviceBIntf, peer = null) => {
  const tasksDeviceA = [];
  const tasksDeviceB = [];

  const removeParams = {
    'tunnel-id': tunnel.num
  };

  // Saving configuration for device A
  tasksDeviceA.push({ entity: 'agent', message: 'remove-tunnel', params: removeParams });

  if (!peer) {
    // Saving configuration for device B
    tasksDeviceB.push({ entity: 'agent', message: 'remove-tunnel', params: removeParams });
  }

  return [tasksDeviceA, tasksDeviceB];
};

/**
 * Calls the necessary APIs for deleting a single tunnel
 * @param  {string}   user         user id of requesting user
 * @param  {string}   org          id of the organization of the user
 * @param  {Object}   tunnel       the tunnel object to be deleted
 * @param  {Object}   deviceA      details of device A
 * @param  {Object}   deviceB      details of device B
 * @param  {Object}   deviceAIntf device A tunnel interface
 * @param  {Object}   deviceBIntf device B tunnel interface
 * @return {void}
 */
const delTunnel = async (
  user,
  org,
  tunnel,
  deviceA,
  deviceB,
  deviceAIntf,
  deviceBIntf,
  pathLabel,
  peer = null
) => {
  const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(
    tunnel,
    deviceAIntf,
    deviceBIntf,
    peer
  );
  try {
    let title = '';
    if (peer) {
      title = 'Delete peer tunnel between (' +
      deviceA.hostname +
      ',' +
      deviceAIntf.name +
      ') and peer (' +
      peer.name +
      ')';
    } else {
      title = 'Delete tunnel between (' +
      deviceA.hostname +
      ',' +
      deviceAIntf.name +
      ') and (' +
      deviceB.hostname +
      ',' +
      deviceBIntf.name +
      ')';
    };
    const tunnelJobs = await queueTunnel(
      false,
      title,
      tasksDeviceA,
      tasksDeviceB,
      user,
      org,
      deviceA.machineId,
      peer ? null : deviceB.machineId,
      deviceA._id,
      peer ? null : deviceB._id,
      tunnel.num,
      pathLabel,
      peer
    );
    logger.debug('Tunnel jobs queued', { params: { jobA: tunnelJobs[0], jobB: tunnelJobs[1] } });
    return tunnelJobs;
  } catch (err) {
    logger.error('Delete tunnel error', { params: { reason: err.message } });
    throw err;
  }
};

/**
 * Creates the tunnels section in the full sync job.
 * @return Array
 */
const sync = async (deviceId, org) => {
  // Get all active tunnels of the devices
  const tunnels = await tunnelsModel.find(
    {
      $and: [
        { org },
        { $or: [{ deviceA: deviceId }, { deviceB: deviceId }] },
        { isActive: true }
      ]
    },
    {
      _id: 1,
      num: 1,
      org: 1,
      deviceA: 1,
      deviceB: 1,
      interfaceA: 1,
      interfaceB: 1,
      tunnelKeys: 1,
      encryptionMethod: 1,
      pathlabel: 1,
      peer: 1
    }
  )
    .populate('deviceA', 'machineId interfaces versions IKEv2')
    .populate('deviceB', 'machineId interfaces versions IKEv2')
    .populate('peer')
    .lean();

  // Create add-tunnel messages
  const tunnelsRequests = [];
  const completeCbData = [];
  let callComplete = false;
  const devicesToSync = [];
  for (const tunnel of tunnels) {
    const {
      _id,
      num,
      deviceA,
      deviceB,
      interfaceA,
      interfaceB,
      tunnelKeys,
      encryptionMethod,
      pathlabel,
      peer
    } = tunnel;

    const ifcA = deviceA.interfaces.find(
      (ifc) => ifc._id.toString() === interfaceA.toString()
    );
    const ifcB = peer ? null : deviceB.interfaces.find(
      (ifc) => ifc._id.toString() === interfaceB.toString()
    );
    if (!tunnelKeys && encryptionMethod === 'psk' && peer === null) {
      // No keys for some reason, probably version 2 upgraded.
      // Tunnel keys will be generated in prepareTunnelAddJob.
      // Need to sync another side as well.
      const remoteDeviceId = deviceId.toString() === deviceA._id.toString()
        ? deviceB._id : deviceA._id;
      logger.warn('No tunnel keys', { params: { tunnelId: _id, deviceId: remoteDeviceId } });
      if (!devicesToSync.includes(remoteDeviceId)) {
        devicesToSync.push(remoteDeviceId);
      }
    }
    const [tasksA, tasksB] = await prepareTunnelAddJob(
      tunnel,
      ifcA,
      ifcB,
      pathlabel,
      deviceA,
      deviceB,
      peer
    );
    // Add the tunnel only for the device that is being synced
    const deviceTasks =
      deviceId.toString() === deviceA._id.toString() ? tasksA : tasksB;
    tunnelsRequests.push(...deviceTasks);

    // Store the data required by the complete callback
    const target =
      deviceId.toString() === deviceA._id.toString()
        ? 'deviceAconf'
        : 'deviceBconf';
    completeCbData.push({
      org,
      username: 'system',
      tunnelId: num,
      target
    });
    callComplete = true;
  };
  // Reset auto sync in database for devices with generated keys
  if (devicesToSync.length > 0) {
    logger.info(
      'Resest autosync to set new keys on devices',
      { params: { devices: devicesToSync } }
    );
    devicesModel.updateMany(
      { _id: { $in: devicesToSync } },
      {
        $set: {
          'sync.state': 'syncing',
          'sync.autoSync': 'on'
        }
      },
      { upsert: false }
    );
  };
  return {
    requests: tunnelsRequests,
    completeCbData,
    callComplete
  };
};

/**
 * Prepares common parameters for add/remove tunnel jobs
 * @param  {Object} tunnel      the tunnel object
 * @param  {Object} deviceAIntf device A tunnel interface
 * @param  {Object?} deviceBIntf device B tunnel interface
 * @param  {pathLabel?} path label used for this tunnel
 * @param  {Object?}  peer peer configurations. If exists, fill peer configurations
*/
const prepareTunnelParams = (tunnel, deviceAIntf, deviceBIntf, pathLabel = null, peer = null) => {
  const paramsDeviceA = {};
  const paramsDeviceB = {};

  // Generate from the tunnel num: IP A/B, MAC A/B, SA A/B
  const tunnelParams = generateTunnelParams(tunnel.num);

  // no additional header for not encrypted tunnels
  const packetHeaderSize = tunnel.encryptionMethod === 'none' ? 0 : 150;

  // Create common settings for both tunnel types
  paramsDeviceA['encryption-mode'] = tunnel.encryptionMethod;
  paramsDeviceA.dev_id = deviceAIntf.devId;
  paramsDeviceA.src = deviceAIntf.IPv4;
  paramsDeviceA['tunnel-id'] = tunnel.num;

  if (peer) {
    // destination
    paramsDeviceA.peer = {};

    paramsDeviceA.dst = peer.remoteIP;

    // handle peer configurations
    paramsDeviceA.peer.addr = tunnelParams.ip1 + '/31';
    paramsDeviceA.peer.mtu = (deviceAIntf.mtu || 1500) - packetHeaderSize;
    paramsDeviceA.peer.multilink = {
      labels: pathLabel ? [pathLabel] : []
    };
    paramsDeviceA.peer.urls = peer.urls;
    paramsDeviceA.peer.ips = peer.ips;
  } else {
    // destination
    const isLocal = (!deviceAIntf.PublicIP || !deviceBIntf.PublicIP ||
      deviceAIntf.PublicIP === deviceBIntf.PublicIP);
    paramsDeviceA.dst = isLocal ? deviceBIntf.IPv4 : deviceBIntf.PublicIP;
    paramsDeviceA.dstPort = (isLocal || !deviceBIntf.PublicPort || deviceBIntf.useFixedPublicPort)
      ? configs.get('tunnelPort') : deviceBIntf.PublicPort;

    // mtu
    const mtu = Math.min(deviceAIntf.mtu || 1500, deviceBIntf.mtu || 1500) - packetHeaderSize;

    paramsDeviceA['loopback-iface'] = {
      addr: tunnelParams.ip1 + '/31',
      mac: tunnelParams.mac1,
      mtu: mtu,
      routing: 'ospf',
      multilink: {
        labels: pathLabel ? [pathLabel] : []
      }
    };

    // handle params device B
    paramsDeviceB['encryption-mode'] = tunnel.encryptionMethod;
    paramsDeviceB.src = deviceBIntf.IPv4;
    paramsDeviceB.dev_id = deviceBIntf.devId;

    paramsDeviceB.dst = isLocal ? deviceAIntf.IPv4 : deviceAIntf.PublicIP;
    paramsDeviceB.dstPort = (isLocal || !deviceAIntf.PublicPort || deviceAIntf.useFixedPublicPort)
      ? configs.get('tunnelPort') : deviceAIntf.PublicPort;
    paramsDeviceB['tunnel-id'] = tunnel.num;
    paramsDeviceB['loopback-iface'] = {
      addr: tunnelParams.ip2 + '/31',
      mac: tunnelParams.mac2,
      mtu: mtu,
      routing: 'ospf',
      multilink: {
        labels: pathLabel ? [pathLabel] : []
      }
    };
  }

  return { paramsDeviceA, paramsDeviceB, tunnelParams };
};

const getInterfacesWithPathLabels = device => {
  const deviceIntfs = [];
  device.interfaces.forEach(intf => {
    if (intf.isAssigned === true && intf.type === 'WAN' && intf.gateway) {
      const labelsSet = new Set(intf.pathlabels.map(label => {
        // DIA interfaces cannot be used in tunnels
        return label.type !== 'DIA' ? label._id : null;
      }));
      deviceIntfs.push({
        labelsSet: labelsSet,
        ...intf.toObject()
      });
    }
  });
  return deviceIntfs;
};

module.exports = {
  apply: {
    applyTunnelAdd: applyTunnelAdd,
    applyTunnelDel: applyTunnelDel
  },
  complete: {
    completeTunnelAdd: completeTunnelAdd,
    completeTunnelDel: completeTunnelDel
  },
  error: {
    errorTunnelAdd: errorTunnelAdd
  },
  sync: sync,
  completeSync: completeSync,
  prepareTunnelRemoveJob: prepareTunnelRemoveJob,
  prepareTunnelAddJob: prepareTunnelAddJob,
  queueTunnel: queueTunnel,
  oneTunnelDel: oneTunnelDel
};
