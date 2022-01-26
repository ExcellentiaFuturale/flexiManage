// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2021  flexiWAN Ltd.

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

// Logic to replace a device
const tunnelsModel = require('../models/tunnels');
const devicesModel = require('../models/devices').devices;
const isEqual = require('lodash/isEqual');

/**
 * Replaces two devices
 * @async
 * @param  {Array}    opDevices an array of operating devices
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (opDevices, user, data) => {
  const { org, meta } = data;
  const { oldId, newId } = meta;
  const oldDevice = oldId ? opDevices.find(d => d._id.toString() === oldId) : false;
  if (!oldDevice) {
    throw new Error('Wrong old device id specified');
  }
  const newDevice = newId ? opDevices.find(d => d._id.toString() === newId) : false;
  if (!newDevice) {
    throw new Error('Wrong new device id specified');
  }
  // check if hardware equal
  const oldInterfaces = oldDevice.interfaces.map(i => i.devId).sort();
  const newInterfaces = newDevice.interfaces.map(i => i.devId).sort();
  if (!isEqual(oldInterfaces, newInterfaces)) {
    throw new Error('The hardware of the devices must be equal');
  }
  // check the new device config
  const tunnelCount = await tunnelsModel.countDocuments({
    $or: [{ deviceA: newId }, { deviceB: newId }],
    isActive: true,
    org: org
  });
  if (tunnelCount > 0) {
    throw new Error('All device tunnels must be deleted on the new device');
  }
  // replace devices in DB
  await devicesModel.remove(
    { _id: newId, org: org }
  );
  await devicesModel.update(
    { _id: oldId, org: org },
    {
      $set: {
        deviceToken: newDevice.deviceToken,
        machineId: newDevice.machineId,
        serial: newDevice.serial,
        hostname: newDevice.hostname
      }
    },
    { upsert: false }
  );
  const status = 'completed';
  const message = 'Replaced successfully';
  return { ids: [], status, message };
};

module.exports = {
  apply
};