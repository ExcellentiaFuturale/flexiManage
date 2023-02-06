// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2023  flexiWAN Ltd.

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

const periodic = require('./periodic')();
const tunnels = require('../models/tunnels');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const configs = require('../configs')();
const ha = require('../utils/highAvailability')(configs.get('redisUrl'));
const pendingReasons = require('../deviceLogic/events/eventReasons');
const publicAddrInfoLimiter = require('../deviceLogic/publicAddressLimiter');
const { activatePendingTunnelsOfDevice } = require('../deviceLogic/events');

/***
 * This class periodically checks if need to release pending tunnels
 ***/
class PendingTunnels {
  /**
  * Creates an instance of the class
  */
  constructor () {
    this.start = this.start.bind(this);
    this.runTask = this.runTask.bind(this);

    // Task information
    this.taskInfo = {
      name: 'release_pending_tunnels',
      func: this.runTask,
      handle: null,
      period: 60000 // 1 minutes
    };
  }

  /**
  * Starts the periodic task.
  * @return {void}
  */
  start () {
    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    periodic.startTask(name);
  }

  /**
  * Called periodically to check if need to release pending tunnels
  * @return {void}
  */
  runTask () {
    ha.runIfActive(async () => {
      const types = pendingReasons.pendingTypes;
      const pendingTunnels = await tunnels.find({
        isPending: true,
        isActive: true,
        pendingType: types.publicPortHighRate
      }).populate('deviceA').populate('deviceB').lean();

      let releasedTunnelsCount = 0;

      const devicesToRelease = new Map();
      for (const tunnel of pendingTunnels) {
        const { deviceA, deviceB, ifcA, ifcB, num, org } = tunnel;

        // check if blockage is already removed.
        // If the block does not exist, it means that the public port is stable
        // and has not changed much recently. Therefore it can be released.
        const keyA = `${deviceA}:${ifcA}`;
        const isIfcABlocked = await publicAddrInfoLimiter.isBlocked(keyA);
        if (isIfcABlocked) continue;

        if (deviceB) {
          const keyB = `${deviceB}:${ifcB}`;
          const isIfcBBlocked = await publicAddrInfoLimiter.isBlocked(keyB);
          if (isIfcBBlocked) continue;
        }

        logger.info('releasing tunnel. Public port limiter already removed', {
          params: { num, org }
        });

        releasedTunnelsCount++;

        devicesToRelease.set(deviceA._id.toString(), deviceA);
        if (deviceB) {
          devicesToRelease.set(deviceB._id.toString(), deviceB);
        }
      }

      for (const deviceId in Object.fromEntries(devicesToRelease)) {
        const device = devicesToRelease.get(deviceId);
        await activatePendingTunnelsOfDevice(device);
      }

      const pendingFound = pendingTunnels.length > 0;
      if (pendingFound) {
        logger.info('release_pending_tunnels task. ' +
          `found=${pendingTunnels.length}. trying to release=${releasedTunnelsCount}.`);
      }
    });
  }
};

let pendingTunnels = null;
module.exports = function () {
  if (pendingTunnels) return pendingTunnels;
  else {
    pendingTunnels = new PendingTunnels();
    return pendingTunnels;
  }
};
