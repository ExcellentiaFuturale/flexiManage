// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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

const Service = require('./Service');
const { devices, staticroutes } = require('../models/devices');
const tunnelsModel = require('../models/tunnels');
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const { deviceStats } = require('../models/analytics/deviceStats');
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const mongoConns = require('../mongoConns.js')();
const mongoose = require('mongoose');
const pick = require('lodash/pick');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const flexibilling = require('../flexibilling');
const dispatcher = require('../deviceLogic/dispatcher');
const { validateDevice } = require('../deviceLogic/validators');

class DevicesService {
  /**
   * Execute an action on the device side
   *
   * action String Command to execute
   * commandRequest CommandRequest  (optional)
   * no response value expected for this operation
   **/
  static async devicesApplyPOST ({ deviceCommand }, { user }) {
    try {
      // Find all devices of the organization
      const opDevices = await devices.find({ org: user.defaultOrg._id });
      // Apply the device command
      await dispatcher.apply(opDevices, deviceCommand.method, user, deviceCommand);

      return Service.successResponse({}, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Execute an action on the device side
   *
   * action String Command to execute
   * commandRequest CommandRequest  (optional)
   * no response value expected for this operation
   **/
  static async devicesIdApplyPOST ({ id, deviceCommand }, { user }) {
    try {
      const opDevice = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });

      if (opDevice.length === 1) {
        await dispatcher.apply(opDevice, deviceCommand.method, user, deviceCommand);
      } else {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }
      return Service.successResponse({}, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Select the API fields from mongo Device Object
   *
   * @param {mongo Device Object} item
   */
  static selectDeviceParams (item) {
    // Pick relevant fields
    const retDevice = pick(item, [
      'org',
      'description',
      'defaultRoute',
      'deviceToken',
      'machineId',
      'site',
      'hostname',
      'name',
      '_id',
      'pendingDevModification',
      'isApproved',
      'fromToken',
      'account',
      'ipList',
      // Internal array, objects
      'labels',
      'staticroutes',
      'upgradeSchedule']);

    // pick interfaces
    const retInterfaces = item.interfaces.map(i => {
      const retIf = pick(i, [
        'IPv6',
        'PublicIP',
        'IPv4',
        'type',
        'MAC',
        'routing',
        'IPv6Mask',
        'isAssigned',
        'driver',
        'IPv4Mask',
        'name',
        'pciaddr',
        '_id'
      ]);
      retIf._id = retIf._id.toString();
      return retIf;
    });

    // Update with additional objects
    retDevice._id = retDevice._id.toString();
    retDevice.account = retDevice.account.toString();
    retDevice.org = retDevice.org.toString();
    retDevice.upgradeSchedule = pick(item.upgradeSchedule, ['jobQueued', '_id', 'time']);
    retDevice.upgradeSchedule._id = retDevice.upgradeSchedule._id.toString();
    retDevice.versions = pick(item.versions, ['agent', 'router', 'device', 'vpp', 'frr']);
    retDevice.interfaces = retInterfaces;
    retDevice.isConnected = connections.isConnected(retDevice.machineId);
    // Add interface stats to mongoose response
    retDevice.deviceStatus = retDevice.isConnected
      ? deviceStatus.getDeviceStatus(retDevice.machineId) || 0 : 0;

    return retDevice;
  }

  /**
   * Get all registered devices
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async devicesGET ({ org, offset, limit }, { user }) {
    try {
      const result = await devices.find({ org: user.defaultOrg._id });

      const devicesMap = result.map(item => {
        return DevicesService.selectDeviceParams(item);
      });

      return Service.successResponse(devicesMap);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async devicesUpgdSchedPOST ({ devicesUpgradeRequest }, { user }) {
    try {
      const query = { _id: { $in: devicesUpgradeRequest.devices }, org: user.defaultOrg._id };
      const numOfIdsFound = await devices.countDocuments(query);

      // The request is considered invalid if not all device IDs
      // are found in the database. This is done to prevent a partial
      // schedule of the devices in case of a user's mistake.
      if (numOfIdsFound < devicesUpgradeRequest.devices.length) {
        return Service.rejectResponse(new Error('Some devices were not found'), 404);
      }

      const set = {
        $set: {
          upgradeSchedule: {
            time: devicesUpgradeRequest.date,
            jobQueued: false
          }
        }
      };

      const options = { upsert: false, useFindAndModify: false };
      await devices.updateMany(query, set, options);
      return Service.successResponse();
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async devicesIdUpgdSchedPOST ({ id, deviceUpgradeRequest }, { user }) {
    try {
      const query = { _id: id, org: user.defaultOrg._id };
      const set = {
        $set: {
          upgradeSchedule: {
            time: deviceUpgradeRequest.date,
            jobQueued: false
          }
        }
      };

      const options = { upsert: false, useFindAndModify: false };
      const res = await devices.updateOne(query, set, options);
      if (res.n === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      } else {
        return Service.successResponse();
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get device software version
   *
   * returns DeviceLatestVersion
   **/
  static async devicesLatestVersionsGET ({ org }) {
    try {
      const swUpdater = await DevSwUpdater.getSwVerUpdaterInstance();
      return Service.successResponse({
        versions: swUpdater.getLatestSwVersions(),
        versionDeadline: swUpdater.getVersionUpDeadline()
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device
   *
   * id String Numeric ID of the Device to retrieve
   * Returns Device
   **/
  static async devicesIdGET ({ id }, { user }) {
    try {
      const result = await devices.findOne({ _id: id, org: user.defaultOrg._id });
      const device = DevicesService.selectDeviceParams(result);

      return Service.successResponse([device]);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device configuration
   *
   * id String Numeric ID of the Device to retrieve configuration from
   * Returns Device Configuration
   **/
  static async devicesIdConfigurationGET ({ id }, { user }) {
    try {
      const device = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });
      if (!device || device.length === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          status: 'disconnected',
          configurations: []
        });
      }

      const deviceConf = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-router-config' }
      );

      if (!deviceConf.ok) {
        logger.error('Failed to get device configuration', {
          params: {
            deviceId: id,
            response: deviceConf.message
          }
        });
        return Service.rejectResponse(new Error('Failed to get device configuration'), 500);
      }

      return Service.successResponse({
        status: 'connected',
        configuration: deviceConf.message
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device logs information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * filter String Filter to be applied (optional)
   * returns DeviceLog
   **/
  static async devicesIdLogsGET ({ id, offset, limit, filter }, { user }) {
    try {
      const device = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });
      if (!device || device.length === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          status: 'disconnected',
          log: []
        });
      }

      const deviceLogs = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        {
          entity: 'agent',
          message: 'get-device-logs',
          params: {
            lines: limit || '100',
            filter: filter || 'all'
          }
        }
      );

      if (!deviceLogs.ok) {
        logger.error('Failed to get device logs', {
          params: {
            deviceId: id,
            response: deviceLogs.message
          }
        });
        return Service.rejectResponse('Failed to get device logs', 500);
      }

      return Service.successResponse({
        status: 'connected',
        logs: deviceLogs.message
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete device
   *
   * id String Numeric ID of the Device to delete
   * no response value expected for this operation
   **/
  static async devicesIdDELETE ({ id }, { user }) {
    let session;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();
      const tunnelCount = await tunnelsModel.countDocuments({
        $or: [{ deviceA: id }, { deviceB: id }],
        isActive: true,
        org: user.defaultOrg._id
      }).session(session);

      if (tunnelCount > 0) {
        logger.debug('Tunnels found when deleting device',
          { params: { deviceId: id }, user: user });
        throw new Error('All device tunnels must be deleted before deleting a device');
      }

      const delDevices = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      }).session(session);

      if (!delDevices.length) throw new Error('Device for deletion not found');
      connections.deviceDisconnect(delDevices[0].machineId);
      const deviceCount = await devices.countDocuments({
        account: delDevices[0].account
      }).session(session);

      // Unregister a device (by adding -1)
      await flexibilling.registerDevice({
        account: delDevices[0].account,
        count: deviceCount,
        increment: -1
      }, session);

      // Now we can remove the device
      await devices.remove({
        _id: id,
        org: user.defaultOrg._id
      }).session(session);

      await session.commitTransaction();
      session = null;

      return Service.successResponse();
    } catch (e) {
      if (session) session.abortTransaction();
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify device
   *
   * id String Numeric ID of the Device to modify
   * deviceRequest DeviceRequest  (optional)
   * returns Device
   **/
  static async devicesIdPUT ({ id, deviceRequest }, { user }) {
    let session;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();

      const origDevice = await devices.findOne({
        id: id,
        org: user.defaultOrg._id
      }).session(session);

      // Don't allow any changes if the device is not approved
      if (!origDevice.isApproved && !deviceRequest.isApproved) {
        throw new Error('Device must be first approved');
      }

      // Validate device changes only for approved devices,
      // and only if the request contains interfaces.
      if (origDevice.isApproved && deviceRequest.interfaces) {
        const { valid, err } = validateDevice(deviceRequest);
        if (!valid) {
          logger.warn('Device update failed',
            {
              params: { device: deviceRequest, err: err }
            });
          throw new Error('Device update failed');
        }
      }

      // If device changed to not approved disconnect it's socket
      if (deviceRequest.isApproved === false) connections.deviceDisconnect(origDevice.machineId);

      // TBD: Remove these fields from the yaml PUT request
      delete deviceRequest.machineId;
      delete deviceRequest.org;
      delete deviceRequest.hostname;
      delete deviceRequest.ipList;
      delete deviceRequest.fromToken;
      delete deviceRequest.deviceToken;
      delete deviceRequest.state;
      delete deviceRequest.emailTokens;
      delete deviceRequest.defaultAccount;
      delete deviceRequest.defaultOrg;

      // Currently we allow only one change at a time to the device,
      // to prevent inconsistencies between the device and the MGMT database.
      // Therefore, we block the request if there's a pending change in the queue.
      if (origDevice.pendingDevModification) {
        throw new Error('Only one device change is allowed at any time');
      }

      const updDevice = await devices.findOneAndUpdate(
        { id: id, org: user.defaultOrg._id },
        deviceRequest,
        { new: true, upsert: false, runValidators: true }
      ).session(session);

      await session.commitTransaction();
      session = null;

      // If the change made to the device fields requires a change on the
      // device itself, add a 'modify' job to the device's queue.
      if (origDevice) {
        await dispatcher.apply([origDevice], 'modify', user, {
          newDevice: updDevice
        });
      }

      return DevicesService.selectDeviceParams(updDevice);
    } catch (e) {
      if (session) session.abortTransaction();

      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device routes information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async devicesIdRoutesGET ({ id, offset, limit }, { user }) {
    try {
      const device = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });
      if (!device || device.length === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          status: 'disconnected',
          osRoutes: [],
          vppRoutes: []
        });
      }

      const deviceOsRoutes = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-device-os-routes' }
      );

      if (!deviceOsRoutes.ok) {
        logger.error('Failed to get device routes', {
          params: {
            deviceId: id,
            response: deviceOsRoutes.message
          },
          req: null
        });
        return Service.rejectResponse(new Error('Failed to get device routes'), 500);
      }
      const response = {
        status: 'connected',
        osRoutes: deviceOsRoutes.message,
        vppRoutes: []
      };
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device static routes information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns StaticRoute
   **/
  static async devicesIdStaticroutesGET ({ id, offset, limit }, { user }) {
    try {
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }

      const device = deviceObject[0];
      const routes = device.staticroutes.map(value => {
        return {
          id: value.id,
          destination_network: value.destination,
          gateway_ip: value.gateway,
          ifname: value.ifname,
          status: value.status
        };
      });
      return Service.successResponse(routes);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete static route
   *
   * id String Numeric ID of the Device
   * route String Numeric ID of the Route to delete
   * no response value expected for this operation
   **/
  static async devicesIdStaticroutesRouteDELETE ({ id, route }, { user }) {
    try {
      const device = await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(id) },
        { $set: { 'staticroutes.$[elem].status': 'waiting' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(id) }]
        }
      );

      const copy = Object.assign({}, route);
      copy.method = 'staticroutes';
      copy.id = route;
      copy.action = 'del';
      await dispatcher.apply(devices, copy.method, user, copy);
      return Service.successResponse({ deviceId: device.id });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Create new static route
   *
   * id String Numeric ID of the Device
   * staticRouteRequest StaticRouteRequest  (optional)
   * returns DeviceStaticRouteInformation
   **/
  static async devicesIdStaticroutesPOST ({ id, staticRouteRequest }, { user }) {
    try {
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }
      if (!deviceObject[0].isApproved && !staticRouteRequest.isApproved) {
        return Service.rejectResponse(new Error('Device must be first approved'), 400);
      }
      const device = deviceObject[0];

      // eslint-disable-next-line new-cap
      const route = new staticroutes({
        destination: staticRouteRequest.destination_network,
        gateway: staticRouteRequest.gateway_ip,
        ifname: staticRouteRequest.ifname,
        status: 'waiting'
      });

      await devices.findOneAndUpdate(
        { _id: device._id },
        {
          $push: {
            staticroutes: route
          }
        },
        { new: true }
      );

      const copy = Object.assign({}, staticRouteRequest);

      copy.method = 'staticroutes';
      copy.id = route.id;
      await dispatcher.apply(device, copy.method, user, copy);
      return Service.successResponse({});
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify static route
   *
   * id String Numeric ID of the Device
   * route String Numeric ID of the Route to modify
   * staticRouteRequest StaticRouteRequest  (optional)
   * returns StaticRoute
   **/
  static async devicesIdStaticroutesRoutePATCH ({ id, route, staticRouteRequest }, { user }) {
    try {
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: user.defaultOrg._id
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse(new Error('Device not found'), 404);
      }
      if (!deviceObject[0].isApproved && !staticRouteRequest.isApproved) {
        return Service.rejectResponse(new Error('Device must be first approved'), 400);
      }

      const device = deviceObject[0];
      const copy = Object.assign({}, staticRouteRequest);

      copy.method = 'staticroutes';
      copy.action = staticRouteRequest.status === 'add-failed' ? 'add' : 'del';
      await dispatcher.apply(device, copy.method, user, copy);
      return Service.successResponse({ deviceId: device.id });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async queryDeviceStats ({ org, id, startTime, endTime }) {
    const match = { org: mongoose.Types.ObjectId(org) };

    if (id) match.device = mongoose.Types.ObjectId(id);
    if (startTime && endTime) {
      match.$and = [{ time: { $gte: startTime } }, { time: { $lte: endTime } }];
    } else if (startTime) match.time = { $gte: startTime };
    else if (endTime) match.time = { $lte: endTime };

    const pipeline = [
      { $match: match },
      { $project: { time: 1, stats: { $objectToArray: '$stats' } } },
      { $unwind: '$stats' },
      {
        $group:
              {
                _id: { time: '$time', interface: 'All' },
                rx_bps: { $sum: '$stats.v.rx_bps' },
                tx_bps: { $sum: '$stats.v.tx_bps' },
                rx_pps: { $sum: '$stats.v.rx_pps' },
                tx_pps: { $sum: '$stats.v.tx_pps' }
              }
      },
      {
        $project: {
          _id: 0,
          time: '$_id.time',
          interface: '$_id.interface',
          rx_bps: '$rx_bps',
          tx_bps: '$tx_bps',
          rx_pps: '$rx_pps',
          tx_pps: '$tx_pps'
        }
      },
      { $sort: { time: -1 } }
    ];

    const stats = await deviceStats.aggregate(pipeline).allowDiskUse(true);
    return stats;
  }

  /**
   * Retrieve devices statistics information
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns DeviceStatistics
   **/
  static async devicesStatisticsGET ({ org }, { user }) {
    try {
      const startTime = Math.floor(new Date().getTime() / 1000) - 7200;
      const endTime = null;

      const stats = await DevicesService.queryDeviceStats({
        org: user.defaultOrg._id.toString(),
        id: null, // null get all devices stats
        startTime: startTime,
        endTime: endTime
      });
      return Service.successResponse(stats);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device statistics information
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns DeviceStatistics
   **/
  static async devicesIdStatisticsGET ({ id }, { user }) {
    try {
      const startTime = Math.floor(new Date().getTime() / 1000) - 7200;
      const endTime = null;

      const stats = await DevicesService.queryDeviceStats({
        org: user.defaultOrg._id.toString(),
        id: id,
        startTime: startTime,
        endTime: endTime
      });
      return Service.successResponse(stats);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = DevicesService;