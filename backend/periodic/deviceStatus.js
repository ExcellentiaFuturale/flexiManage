// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

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
const connections = require('../websocket/Connections')();
const { deviceStats, deviceAggregateStats } = require('../models/analytics/deviceStats');
const notifications = require('../models/notifications');
const notificationsConf = require('../models/notificationsConf');
const applicationStats = require('../models/analytics/applicationStats');
const Joi = require('joi');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const notificationsMgr = require('../notifications/notifications')();
const configs = require('../configs')();
const { getRenewBeforeExpireTime } = require('../deviceLogic/IKEv2');
const orgModel = require('../models/organizations');
const { reconfigErrorsLimiter } = require('../limiters/reconfigErrors');
const { parseLteStatus, mapWifiNames } = require('../utils/deviceUtils');
const tunnels = require('../models/tunnels');
const { createClient } = require('redis');
const { getRedisAuthUrl } = require('../utils/httpUtils');

/***
 * This class gets periodic status from all connected devices
 ***/
class DeviceStatus {
  /**
    * Creates an instance of the DeviceStatus class
    */
  constructor () {
    // Holds the status per deviceID
    this.status = {};
    this.usersDeviceAggregatedStats = {};
    this.statsFieldsMap = new Map([
      ['rx_bytes', 'rx_bps'],
      ['rx_pkts', 'rx_pps'],
      ['tx_bytes', 'tx_bps'],
      ['tx_pkts', 'tx_pps']
    ]);
    this.tunnelFieldMap = new Map([
      ['status', 'status'],
      ['rtt', 'rtt'],
      ['drop_rate', 'drop_rate']
    ]);
    this.lastApplicationsStatusTime = {};

    this.start = this.start.bind(this);
    this.periodicPollDevices = this.periodicPollDevices.bind(this);
    this.periodicPollOneDevice = this.periodicPollOneDevice.bind(this);
    this.getDeviceStatus = this.getDeviceStatus.bind(this);
    this.setDeviceStatus = this.setDeviceStatus.bind(this);
    this.setDeviceState = this.setDeviceState.bind(this);
    this.registerSyncUpdateFunc = this.registerSyncUpdateFunc.bind(this);
    this.removeDeviceStatus = this.removeDeviceStatus.bind(this);
    this.deviceConnectionClosed = this.deviceConnectionClosed.bind(this);

    this.devicesStatusByOrg = {};
    this.setDevicesStatusByOrg = this.setDevicesStatusByOrg.bind(this);
    this.getDevicesStatusByOrg = this.getDevicesStatusByOrg.bind(this);
    this.clearDevicesStatusByOrg = this.clearDevicesStatusByOrg.bind(this);

    this.tunnelsStatusByOrg = {};
    this.setTunnelsStatusByOrg = this.setTunnelsStatusByOrg.bind(this);
    this.getTunnelsStatusByOrg = this.getTunnelsStatusByOrg.bind(this);
    this.clearTunnelsStatusByOrg = this.clearTunnelsStatusByOrg.bind(this);
    this.statusCallback = this.statusCallback.bind(this);

    const { redisAuth, redisUrlNoAuth } = getRedisAuthUrl(configs.get('redisUrl'));
    this.redisClient = createClient({ url: redisUrlNoAuth });
    if (redisAuth) this.redisClient.auth(redisAuth);

    this.redisClient.on('connect', () => {
      logger.info('Connected to Redis');
    });

    this.redisClient.on('error', (err) => {
      logger.error('Redis client encountered an error:', err);
    });

    this.redisClient.on('end', () => {
      logger.info('Redis client disconnected');
    });

    // register a callback function to be called when a device status is received on channel
    connections.registerStatusCallback(this.statusCallback);

    // Task information
    this.updateSyncStatus = async () => {};
    this.taskInfo = {
      name: 'poll_status',
      func: this.periodicPollDevices,
      handle: null,
      period: 10000
    };
  }

  registerSyncUpdateFunc (func) {
    this.updateSyncStatus = func;
  }

  /**
     * Checks the validity of a device-stats message
     * sent by the device.
     * @param  {Object} msg device stat message
     * @return {{valid: boolean, err: string}}
     */
  validateDevStatsMessage (msg) {
    if (!Array.isArray(msg)) {
      return { valid: false, err: 'get-device-stats response should be an array' };
    };

    if (msg.length === 0) return { valid: true, err: '' };

    const devStatsSchema = Joi.object().keys({
      ok: Joi.number().integer().required(),
      running: Joi.boolean().optional(),
      // TBD : when v0.X.X not supported, change to required
      state: Joi.string().valid('running', 'stopped', 'failed').optional(),
      // stateReason:  Joi.string().regex(/^[a-zA-Z0-9]{0,200}$/i).allow('').optional(),
      // TBD: Now no validation, need to fix on agent
      stateReason: Joi.string().allow('').optional(),
      period: Joi.number().required(),
      utc: Joi.date().timestamp('unix').required(),
      tunnel_stats: Joi.object().optional(),
      application_stats: Joi.object().optional(),
      lte_stats: Joi.object().optional(),
      wifi_stats: Joi.object().optional(),
      alerts: Joi.object().optional(),
      alerts_hash: Joi.string().allow('').optional(),
      reconfig: Joi.string().allow('').optional(),
      ikev2: Joi.object({
        certificateExpiration: Joi.string().allow('').optional(),
        error: Joi.string().allow('').optional()
      }).allow({}).optional(),
      health: Joi.object({
        cpu: Joi.array().items(Joi.number()).min(1).optional(),
        mem: Joi.number().optional(),
        disk: Joi.number().optional(),
        temp: Joi.object({
          value: Joi.number(),
          high: Joi.number(),
          critical: Joi.number()
        }).optional()
      }).allow({}).optional(),
      stats: Joi.object().pattern(/^[a-z0-9:._/-]{1,64}$/i, Joi.object({
        rx_bytes: Joi.number().required(),
        rx_pkts: Joi.number().required(),
        tx_bytes: Joi.number().required(),
        tx_pkts: Joi.number().required()
      })),
      vrrp: Joi.object().pattern(Joi.number().min(1).max(255), Joi.object({
        state: Joi.string().valid('Master', 'Backup', 'Initialize', 'Interface Down'),
        adjusted_priority: Joi.number().min(0).max(255).optional()
      })).allow({}).optional(),
      bgp: Joi.object({
        routerId: Joi.string(),
        as: Joi.number(),
        failedPeers: Joi.number(),
        displayedPeers: Joi.number(),
        totalPeers: Joi.number(),
        peers: Joi.object().pattern(Joi.string().ip({ version: ['ipv4'] }), Joi.object({
          remoteAs: Joi.number(),
          msgRcvd: Joi.number(),
          msgSent: Joi.number(),
          peerUptime: Joi.string(),
          peerUptimeMsec: Joi.number(),
          pfxRcd: Joi.number(),
          pfxSnt: Joi.number(),
          state: Joi.string(),
          peerState: Joi.string()
        }))
      }).allow({}).optional()
    });

    for (const updateEntry of msg) {
      const result = devStatsSchema.validate(updateEntry);
      if (result.error) {
        return {
          valid: false,
          err: `${result.error.name}: ${result.error.details[0].message}`
        };
      }
    }

    return { valid: true, err: '' };
  }

  /**
    * Starts the poll_status periodic task.
    * @return {void}
    */
  start () {
    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    periodic.startTask('poll_status');
  }

  /**
    * Polls the status of all connected devices
    * @return {void}
    */
  periodicPollDevices () {
    const devices = connections.getAllDevices();
    devices.forEach((deviceID) => {
      // run periodic task if device is connected to this host
      const { socket } = connections.getDeviceInfo(deviceID) ?? {};
      if (connections.isSocketAlive(socket)) this.periodicPollOneDevice(deviceID);
    });
  }

  async generateAlertKey (eventType, eventTargets, isResolved, orgId, defaultSeverity = '') {
    let targetId;
    let severity = defaultSeverity;
    if (!severity) {
      const orgNotificationsConf = await notificationsConf.findOne({ org: orgId });
      const rules = orgNotificationsConf.rules;
      severity = rules[eventType].severity;
    }

    // If "tunnelId" is in eventTargets, use it exclusively since we don't want
    // to get a different key for the same tunnel alert from another device
    if (eventTargets.tunnelId) {
      targetId = `tunnelId:${eventTargets.tunnelId}`;
    } else {
      targetId = Object.entries(eventTargets)
        .filter(([key, value]) => value != null)
        .map(([key, value]) => `${key}:${value}`)
        .join(':');
    }

    if (!targetId) {
      logger.warn('Failed to generate alert key: No valid target ID found', {
        params: { eventType, eventTargets, orgId }
      });
      throw new Error('Unable to generate alert key: No valid target ID found');
    }

    const alertKey = `${eventType}:${targetId}:${isResolved}::${severity}${orgId}`;
    return alertKey;
  }

  async handleAlert (
    deviceID, deviceInfo, alertKey, lastUpdateEntry, tunnelNum = null) {
    let { value, unit, threshold, type } = tunnelNum
      ? lastUpdateEntry.alerts[alertKey][tunnelNum]
      : lastUpdateEntry.alerts[alertKey];

    // Ensure that 'value' has only one digit after the '.'
    value = parseFloat(value.toFixed(1));
    try {
      this.createAndPushEvent(
        deviceInfo, lastUpdateEntry.alerts, alertKey,
        { value, threshold, unit, type }, tunnelNum);
    } catch (err) {
      logger.error(`Failed to add the "${alertKey}" alert for
       ${tunnelNum ? 'tunnel ' + tunnelNum : 'device ' + deviceInfo.name}`
      , {
        params: { deviceID: deviceID, err: err.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  getThresholdInfo (
    alertKey, notificationsConfRules, severity, org, tunnelId = null) {
    const thresholdType = (severity === 'warning') ? 'warningThreshold' : 'criticalThreshold';

    const thresholdValue = tunnelId
      ? (tunnels.findOne(
        { num: tunnelId, org }, { fields: { notificationsSettings: 1 } }
      )?.notificationsSettings?.[thresholdType] ?? notificationsConfRules[alertKey][thresholdType])
      : notificationsConfRules[alertKey][thresholdType];

    const thresholdUnit = notificationsConfRules[alertKey].thresholdUnit;

    return { threshold: thresholdValue, unit: thresholdUnit };
  }

  async handleResolvedAlerts (alerts, lastUpdateEntry, deviceID, orgNotificationsConf, deviceInfo) {
    try {
      const agentOnlyAlerts = ['Link/Tunnel round trip time',
        'Link/Tunnel default drop rate', 'Device memory usage', 'Hard drive usage', 'Temperature'];
      const notificationsConfRules = orgNotificationsConf.rules;

      for (const alertKey in alerts) {
        const isAgentAlert = agentOnlyAlerts.includes(alertKey);
        if (!isAgentAlert) {
          continue;
        }
        if (alerts[alertKey].type === 'device') {
          if ((!lastUpdateEntry.alerts[alertKey] ||
            lastUpdateEntry.alerts[alertKey].severity !== alerts[alertKey].severity)) {
            const agentAlertsInfo = this.getThresholdInfo(
              alertKey, notificationsConfRules, alerts[alertKey].severity, deviceInfo.org);
            this.createAndPushEvent(
              deviceInfo, alerts, alertKey,
              agentAlertsInfo, null, true);
          }
        } else {
          this.resolveTunnelAlerts(
            alertKey, alerts, lastUpdateEntry, deviceInfo, notificationsConfRules);
        }
      }
    } catch (error) {
      logger.error(`Failed to resolve alert for device ${deviceInfo.name}`, {
        params: { deviceID: deviceID, err: error.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  resolveTunnelAlerts (alertKey, alerts, lastUpdateEntry, deviceInfo, notificationsConfRules) {
    for (const tunnelId in alerts[alertKey]) {
      const alertExistsForTunnel = lastUpdateEntry.alerts[alertKey]?.[tunnelId];
      const severityHasChanged = alertExistsForTunnel &&
      alertExistsForTunnel.severity !== alerts[alertKey][tunnelId].severity;

      const shouldResolveTunnelAlert = !lastUpdateEntry.alerts[alertKey] ||
       !alertExistsForTunnel || severityHasChanged;

      if (shouldResolveTunnelAlert) {
        const agentAlertsInfo = this.getThresholdInfo(
          alertKey,
          notificationsConfRules,
          alerts[alertKey][tunnelId].severity,
          deviceInfo.org, tunnelId
        );
        this.createAndPushEvent(
          deviceInfo, alerts, alertKey,
          agentAlertsInfo, tunnelId, true);
      }
    }
  }

  async createAndPushEvent (
    deviceInfo, alerts, eventName,
    agentAlertsInfo, tunnelId = null, isResolved = false) {
    const { org, deviceObj: deviceId, name } = deviceInfo;
    const targets = {
      deviceId,
      tunnelId,
      interfaceId: null
    };
    const severity = tunnelId ? alerts[eventName][tunnelId].severity : alerts[eventName].severity;

    const notificationKey = await this.generateAlertKey(
      eventName, targets, isResolved, org, severity);

    const title = isResolved ? `[resolved] ${eventName}` : eventName;
    const details = 'The value of the ' + eventName + ' in ' + (tunnelId ? 'tunnel ' +
    tunnelId : 'device ' + name) + ' has ' + (isResolved ? 'returned to normal (under ' +
    agentAlertsInfo.threshold + agentAlertsInfo.unit + ')' : 'increased to ' +
    agentAlertsInfo.value + agentAlertsInfo.unit);
    const event = {
      org,
      title,
      details,
      eventType: eventName,
      targets,
      severity,
      resolved: isResolved,
      agentAlertsInfo
    };

    await this.saveEventToRedis(notificationKey, event);
  }

  acquireLock (redisClient, key, ttl, cb) {
    redisClient.set(key, 'LOCK', 'PX', ttl, 'NX', (err, reply) => {
      if (err) {
        logger.error('Lock acquisition failed.', { params: { error: err, key } });
        return cb(err);
      }
      if (reply === 'OK') {
        return cb(null, true);
      } else {
        logger.warn('Lock acquisition denied. Key already locked.', { params: { key } });
        return cb(null, false);
      }
    });
  }

  releaseLock (redisClient, key, cb) {
    redisClient.del(key, (err) => {
      if (err) {
        logger.error('Failed to release lock.', { params: { key, error: err } });
      }
      cb(err);
    });
  }

  async saveEventToRedis (key, event) {
    return new Promise((resolve, reject) => {
      // First, try to acquire the lock
      this.acquireLock(this.redisClient, key, 30000, (lockErr, acquired) => {
        if (lockErr || !acquired) {
          return reject(new Error('Failed to acquire lock or key already exists.'));
        }

        logger.debug('Acquired lock to send alert.', { params: { key, event } });

        // Lock was acquired successfully. Send the notification.
        notificationsMgr.sendNotifications([event])
          .then(() => {
            logger.info('Alert processed. Releasing lock & deleting from Redis.',
              { params: { key } });

            // Release the lock after sending the notification
            this.releaseLock(this.redisClient, key, (releaseErr) => {
              if (releaseErr) {
                return reject(releaseErr);
              }
              resolve('Notification sent and lock released.');
            });
          })
          .catch((sendErr) => {
            // Even if there's an error sending the notification, release the lock
            logger.error('Alert processing failed. Releasing lock & deleting from Redis.',
              { params: { key, error: sendErr } });
            this.releaseLock(this.redisClient, key, () => {
              reject(sendErr);
            });
          });
      });
    });
  }

  async calculateNotifications (deviceID, deviceInfo, lastUpdateEntry) {
    const orgNotificationsConf = await notificationsConf.findOne({ org: deviceInfo.org });
    for (const alertKey in lastUpdateEntry.alerts) {
      if (alertKey.toLowerCase().includes('tunnel')) {
        for (const tunnelId in lastUpdateEntry.alerts[alertKey]) {
          await this.handleAlert(
            deviceID, deviceInfo, alertKey, lastUpdateEntry, tunnelId);
        }
      } else {
        await this.handleAlert(
          deviceID, deviceInfo, alertKey, lastUpdateEntry);
      }
    }
    // handle resolved alerts if needed (exist in the memory but not in the current alerts)
    if (deviceInfo.alerts) {
      await this.handleResolvedAlerts(
        deviceInfo.alerts, lastUpdateEntry, deviceID, orgNotificationsConf, deviceInfo);
      // There is no memory so we should look after the unresolved alerts in th db
    } else {
      const previousAlerts = await notifications.find({
        'targets.deviceId': deviceInfo.deviceObj,
        resolved: false
      });
      const prevAlertsDict = {};
      for (let i = 0; i < previousAlerts.length; i++) {
        if (previousAlerts[i].severity) {
          if (previousAlerts[i].targets?.tunnelId) {
            const tunnelId = previousAlerts[i].targets.tunnelId;
            const eventType = previousAlerts[i].eventType;
            prevAlertsDict[eventType] = {
              [tunnelId]: {
                value: previousAlerts[i].agentAlertsInfo.value,
                threshold: previousAlerts[i].agentAlertsInfo.threshold,
                severity: previousAlerts[i].severity,
                unit: previousAlerts[i].agentAlertsInfo.unit,
                type: previousAlerts[i].agentAlertsInfo.type
              }
            };
          } else {
            prevAlertsDict[previousAlerts[i].eventType] = {
              value: previousAlerts[i].agentAlertsInfo.value,
              threshold: previousAlerts[i].agentAlertsInfo.threshold,
              severity: previousAlerts[i].severity,
              unit: previousAlerts[i].agentAlertsInfo.unit,
              type: previousAlerts[i].agentAlertsInfo.type
            };
          }
        }
      }
      await this.handleResolvedAlerts(
        prevAlertsDict, lastUpdateEntry, deviceID, orgNotificationsConf, deviceInfo);
    }
  }

  /**
     * Sends a get-device-stats message to a device.
     * @param  {string} deviceID the host id of the device
     * @return {void}
     */
  periodicPollOneDevice (deviceID) {
    connections.deviceSendMessage(null, deviceID,
      { entity: 'agent', message: 'get-device-stats' }, undefined, '', this.validateDevStatsMessage)
      .then(async (msg) => {
        if (msg != null) {
          if (msg.ok === 1) {
            if (msg.message.length === 0) return;
            // Update device status according to the last update entry in the list
            const lastUpdateEntry = msg.message[msg.message.length - 1];
            const deviceInfo = connections.getDeviceInfo(deviceID);
            if (!deviceInfo) {
              logger.warn('Failed to get device info', {
                params: { deviceID: deviceID, message: msg },
                periodic: { task: this.taskInfo }
              });
              return;
            }
            await this.setDeviceStatus(deviceID, deviceInfo, lastUpdateEntry);
            this.updateAnalyticsInterfaceStats(deviceID, deviceInfo, msg.message);
            this.updateAnalyticsApplicationsStats(deviceID, deviceInfo, msg.message);
            this.updateUserDeviceStats(deviceInfo.org, deviceID, msg.message);
            if ((!deviceInfo.notificationsHash && lastUpdateEntry.alerts_hash) ||
                deviceInfo.notificationsHash !== lastUpdateEntry.alerts_hash) {
              await this.calculateNotifications(deviceID, deviceInfo, lastUpdateEntry);
              connections.devices.updateDeviceInfo(
                deviceID, 'notificationsHash', lastUpdateEntry.alerts_hash);
              connections.devices.updateDeviceInfo(
                deviceID, 'alerts', lastUpdateEntry.alerts);
            }

            this.updateDeviceSyncStatus(
              deviceInfo.org,
              deviceInfo.deviceObj,
              deviceID,
              msg['router-cfg-hash']
            );
            // check if need to generate a new IKEv2 certificate
            let needNewIKEv2Certificate = false;
            const { encryptionMethod } = await orgModel.findOne({ _id: deviceInfo.org });

            if (encryptionMethod === 'ikev2') {
              const { ikev2 } = lastUpdateEntry;
              if (!ikev2) {
                needNewIKEv2Certificate = true;
              } else if (ikev2.error) {
                logger.warn('IKEv2 certificate error on device', {
                  params: { deviceID: deviceID, err: ikev2.error },
                  periodic: { task: this.taskInfo }
                });
                needNewIKEv2Certificate = true;
              } else {
                const certificateExpiration =
                  (new Date(ikev2.certificateExpiration)).getTime();
                // check if expiration is different on agent and management
                // or certificate is about to expire
                if (deviceInfo.certificateExpiration !== certificateExpiration ||
                  certificateExpiration < getRenewBeforeExpireTime()) {
                  needNewIKEv2Certificate = true;
                }
              }
            }

            // Check if config was modified on the device or need to check IKEv2 certificate
            const { reconfig } = lastUpdateEntry;
            if ((reconfig && reconfig !== deviceInfo.reconfig) || needNewIKEv2Certificate) {
              // Check if device is blocked due to many error in a row
              const deviceId = deviceInfo.deviceObj.toString();
              const isBlocked = await reconfigErrorsLimiter.isBlocked(deviceId);
              if (!isBlocked) {
                // Call get-device-info and reconfig
                connections.sendDeviceInfoMsg(deviceID, deviceInfo.deviceObj, deviceInfo.org);
              } else {
                logger.warn('Failed to send get-device-info due to reconfig errors limiter', {
                  params: { deviceID, reconfig, needNewIKEv2Certificate },
                  periodic: { task: this.taskInfo }
                });
              }
            }
            // status received and updated in memory, so it can be published to other hosts
            connections.publishStatus(deviceID, this.status[deviceID]);
          } else {
            this.setDeviceState(deviceID, 'pending');
          }
        } else {
          logger.warn('Failed to get device status', {
            params: { deviceID: deviceID, message: msg },
            periodic: { task: this.taskInfo }
          });
        }
      }, (err) => {
        logger.warn('Failed to get device status', {
          params: { deviceID: deviceID, err: err.message },
          periodic: { task: this.taskInfo }
        });
        return err;
      })
      .catch((err) => {
        logger.warn('Failed to get device status', {
          params: { deviceID: deviceID, err: err.message },
          periodic: { task: this.taskInfo }
        });
      });
  }

  async updateDeviceSyncStatus (org, deviceId, machineId, hash) {
    try {
      await this.updateSyncStatus(org, deviceId, machineId, hash);
    } catch (err) {
      logger.error('Failed to update device sync status', {
        params: { deviceID: deviceId, err: err.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  /**
     * Updates the applications stats per device in the database
     * @param  {string} deviceID   device UUID
     * @param  {Object} deviceInfo device info stored per connection (org, mongo device id, socket)
     * @param  {Object} stats      contains the per-application stats
     * @return {void}
     */
  updateAnalyticsApplicationsStats (deviceID, deviceInfo, statsList) {
    for (const statsEntry of statsList) {
      // Update the database once per update time configuration (default: 5min)
      const msgTime = Math.floor(statsEntry.utc / configs.get('analyticsUpdateTime', 'number')) *
        configs.get('analyticsUpdateTime', 'number');

      if (this.lastApplicationsStatusTime[deviceID] === msgTime) return;

      const appsStats = statsEntry.application_stats;
      for (const identifier in appsStats) {
        const appData = appsStats[identifier];

        this.lastApplicationsStatusTime[deviceID] = msgTime;

        // update the db
        applicationStats.update(
          // Query
          { org: deviceInfo.org, device: deviceInfo.deviceObj, app: identifier, time: msgTime },
          // Update
          { $set: { stats: appData } },
          // Options
          { upsert: true })
          .then((resp) => {
            logger.debug('Storing applications statistics in DB', {
              params: { deviceId: deviceID, identifier, appData },
              periodic: { task: this.taskInfo }
            });
          }, (err) => {
            logger.warn('Failed to store applications statistics', {
              params: { deviceId: deviceID, identifier, appData, err: err.message },
              periodic: { task: this.taskInfo }
            });
          })
          .catch((err) => {
            logger.warn('Failed to store applications statistics', {
              params: { deviceId: deviceID, identifier, appData, err: err.message },
              periodic: { task: this.taskInfo }
            });
          });
      }
    }
  }

  /**
     * Updates the interface stats per device in the database
     * @param  {string} deviceID   device UUID
     * @param  {Object} stats      contains the per-interface stats: rx/tx bps/pps
     * @param  {Object} deviceInfo device info stored per connection (org, mongo device id, socket)
     * @return {void}
     */
  updateAnalyticsInterfaceStats (deviceID, deviceInfo, statsList) {
    statsList.forEach((statsEntry) => {
      // Update the database once per update time configuration (default: 5min)
      const msgTime = Math.floor(statsEntry.utc / configs.get('analyticsUpdateTime', 'number')) *
        configs.get('analyticsUpdateTime', 'number');
      if (this.getDeviceLastUpdateTime(deviceID) === msgTime) return;

      // Build DB updates
      const dbStats = {};
      let shouldUpdate = false;
      const stats = statsEntry.stats;
      for (const intf in stats) {
        if (!stats.hasOwnProperty(intf)) continue;
        const intfStats = stats[intf];
        for (const stat in intfStats) {
          if (!intfStats.hasOwnProperty(stat) || !this.statsFieldsMap.get(stat)) continue;
          const key = 'stats.' + intf.replaceAll('.', ':') + '.' + this.statsFieldsMap.get(stat);
          dbStats[key] = intfStats[stat] / statsEntry.period;
          shouldUpdate = true;
        }
      }
      // Add tunnel info
      const tunnelStats = statsEntry.tunnel_stats;
      for (const tunnelId in tunnelStats) {
        if (!tunnelStats.hasOwnProperty(tunnelId)) continue;
        const tunnelIdStats = tunnelStats[tunnelId];
        for (const stat in tunnelIdStats) {
          if (!tunnelIdStats.hasOwnProperty(stat)) continue;
          if (this.statsFieldsMap.get(stat)) {
            const key = 'tunnels.' + tunnelId + '.' + this.statsFieldsMap.get(stat);
            dbStats[key] = tunnelIdStats[stat] / statsEntry.period;
            shouldUpdate = true;
          }
          if (this.tunnelFieldMap.get(stat)) {
            const key = 'tunnels.' + tunnelId + '.' + this.tunnelFieldMap.get(stat);
            dbStats[key] = tunnelIdStats[stat];
            shouldUpdate = true;
          }
        }
      }
      // Update health info
      const healthStats = statsEntry.health;
      for (const param in healthStats) {
        dbStats['health.' + param] = healthStats[param];
        shouldUpdate = true;
      }

      if (!shouldUpdate) return;
      this.setDeviceStatsField(deviceID, 'lastUpdateTime', msgTime);

      deviceStats.update(
        // Query
        { org: deviceInfo.org, device: deviceInfo.deviceObj, time: msgTime },
        // Update
        { $set: dbStats },
        // Options
        { upsert: true })
        .then((resp) => {
          logger.debug('Storing interfaces statistics in DB', {
            params: { deviceId: deviceID, stats: statsEntry },
            periodic: { task: this.taskInfo }
          });
        }, (err) => {
          logger.warn('Failed to store interface statistics', {
            params: { deviceId: deviceID, stats: statsEntry, err: err.message },
            periodic: { task: this.taskInfo }
          });
        })
        .catch((err) => {
          logger.warn('Failed to store interface statistics', {
            params: { deviceId: deviceID, stats: statsEntry, err: err.message },
            periodic: { task: this.taskInfo }
          });
        });
    });
  }

  /**
   * @param  {string} machineId   device machine Id
   * @param  {string} state       device state
   * @return {void}
   */
  async setDeviceState (machineId, newState, needToPublish = true) {
    // Generate an event if there was a transition in the device's status
    const deviceInfo = connections.getDeviceInfo(machineId);
    if (!deviceInfo) {
      logger.warn('Failed to get device info', {
        params: { machineId }
      });
      return;
    }
    const { org, deviceObj: deviceId, name } = deviceInfo;
    if (!this.status[machineId] || newState !== this.status[machineId].state) {
      const targets = {
        deviceId: deviceId,
        tunnelId: null,
        interfaceId: null
      };
      const resolved = newState === 'running';
      const eventType = 'Running router';
      const notificationKey = await this.generateAlertKey(eventType, targets, resolved, org);

      const event = {
        org: org,
        title: newState === 'running' ? '[resolved] Router state change' : 'Router state change',
        details: `Router state changed to ${newState} in the device ${name}`,
        eventType,
        targets,
        resolved
      };

      await this.saveEventToRedis(notificationKey, event);

      this.setDevicesStatusByOrg(org, deviceId, newState);
    }
    this.setDeviceStatsField(machineId, 'state', newState);
    // status updated in memory, publish it to other hosts
    if (needToPublish) {
      connections.publishStatus(machineId, this.status[machineId]);
    }
  }

  /**
    * Store LTE status in memory to improve the response speed of the LTE monitoring requests
    * @param  {string} machineId  device machine id
    * @param  {string} devId LTE device devId
    * @param  {Object} lteStatus   LTE status
    * @return {void}
    */
  setDeviceLteStatus (machineId, devId, lteStatus) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].lteStatus) {
      this.status[machineId].lteStatus = {};
    }
    if (!this.status[machineId].lteStatus[devId]) {
      this.status[machineId].lteStatus[devId] = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].lteStatus[devId], { ...lteStatus, time });
  }

  getDeviceLteStatus (machineId, devId) {
    return this.status?.[machineId]?.lteStatus?.[devId] ?? {};
  }

  /**
    * Store LTE status in memory to improve the response speed of the WiFi monitoring requests
    * @param  {string} machineId  device machine id
    * @param  {string} devId WiFi device devId
    * @param  {Object} wifiStatus   WiFi status
    * @return {void}
    */
  setDeviceWifiStatus (machineId, devId, wifiStatus) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].wifiStatus) {
      this.status[machineId].wifiStatus = {};
    }
    if (!this.status[machineId].wifiStatus[devId]) {
      this.status[machineId].wifiStatus[devId] = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].wifiStatus[devId], { ...wifiStatus, time });
  }

  getDeviceWifiStatus (machineId, devId) {
    return this.status?.[machineId]?.wifiStatus?.[devId] ?? {};
  }

  /**
    * Store Vrrp status in memory
    * @param  {string} machineId  device machine id
    * @param  {string} vrid VRID
    * @param  {Object} status VRRP status
    * @return {void}
    */
  setDeviceVrrpStatus (machineId, vrid, status) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].vrrp) {
      this.status[machineId].vrrp = {};
    }
    if (!this.status[machineId].vrrp[vrid]) {
      this.status[machineId].vrrp[vrid] = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].vrrp[vrid], { ...status, time });
  }

  /**
    * Store BGP status in memory
    * @param  {string} machineId  device machine id
    * @param  {string} vrid VRID
    * @param  {Object} status VRRP status
    * @return {void}
    */
  setDeviceBgpStatus (machineId, status) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].bgp) {
      this.status[machineId].bgp = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].bgp = { ...status, time });
    return this.getDeviceBgpStatus(machineId);
  }

  getDeviceBgpStatus (machineId) {
    return this.status?.[machineId]?.bgp ?? {};
  }

  /**
    * Get the Vrrp status from memory
    * @param  {string} machineId  device machine id
    * @return {void}
    */
  getDeviceVrrpStatus (machineId, vrid) {
    return this?.status?.[machineId]?.vrrp?.[vrid] ?? {};
  }

  /**
    * Clear the Vrrp status from memory
    * @param  {string} machineId  device machine id
    * @return {void}
    */
  clearDeviceVrrpStatus (machineId) {
    delete this?.status?.[machineId]?.vrrp;
  }

  /**
     * @param  {string} machineId  device machine id
     * @param  {Object} deviceInfo device info entry
     * @param  {Object} rawStats   device stats supplied by the device
     * @return {void}
     */
  async setDeviceStatus (machineId, deviceInfo, rawStats) {
    let devStatus = 'failed';
    if (rawStats.hasOwnProperty('state')) { // Agent v1.X.X
      devStatus = rawStats.state;
    // v0.X.X TBD: remove when v0.X.X is not supported, e.g. mgmt=2.X.X
    } else if (rawStats.hasOwnProperty('running')) {
      devStatus = rawStats.running === true ? 'running' : 'stopped';
    }

    await this.setDeviceState(machineId, devStatus, false);
    const { org, deviceObj: deviceId } = deviceInfo;

    // Interface statistics
    const timeDelta = rawStats.period;
    const ifStats = rawStats.hasOwnProperty('stats') ? rawStats.stats : {};
    const devStats = {};

    const appStatus = rawStats.application_stats;
    if (!this.status.hasOwnProperty(machineId)) {
      this.status[machineId] = {};
    }

    if (rawStats.hasOwnProperty('application_stats') && Object.entries(appStatus).length !== 0) {
      if (!this.status[machineId].applicationStatus) {
        this.status[machineId].applicationStatus = {};
      }
      // Generate tunnel notifications
      Object.entries(appStatus).forEach(ent => {
        const [identifier, status] = ent;
        this.status[machineId].applicationStatus[identifier] = {
          running: status.running,
          monitoring: status.statistics
        };
      });
    } else {
      if (this.status[machineId].applicationStatus) {
        for (const identifier in this.status[machineId].applicationStatus) {
          delete this.status[machineId].applicationStatus[identifier];
        }
      }
    }

    // Set lte status in memory for now
    const lteStatus = rawStats.lte_stats;
    if (rawStats.hasOwnProperty('lte_stats') && Object.entries(lteStatus).length !== 0) {
      if (!this.status[machineId].lteStatus) {
        this.status[machineId].lteStatus = {};
      }
      for (const devId in lteStatus) {
        const mappedLteStatus = parseLteStatus(lteStatus[devId]);
        this.setDeviceLteStatus(machineId, devId, mappedLteStatus);
      }
    };

    // Set wifi status in memory for now
    const wifiStatus = rawStats.wifi_stats;
    if (rawStats.hasOwnProperty('wifi_stats') && Object.entries(wifiStatus).length !== 0) {
      if (!this.status[machineId].wifiStatus) {
        this.status[machineId].wifiStatus = {};
      }
      for (const devId in wifiStatus) {
        this.setDeviceWifiStatus(machineId, devId, mapWifiNames(wifiStatus[devId]));
      }
    };

    // Set VRRP status in memory for now
    for (const vrId in rawStats?.vrrp ?? {}) {
      this.setDeviceVrrpStatus(machineId, vrId, rawStats.vrrp[vrId]);
    }

    // Set BGP status in memory for now.
    // ""> 0" since bgp status arrives once in a few minutes
    if (Object.entries(rawStats?.bgp ?? {}).length > 0) {
      this.setDeviceBgpStatus(machineId, rawStats.bgp);
    }

    // Set tunnel status in memory for now
    const tunnelStatus = rawStats.tunnel_stats;
    if (rawStats.hasOwnProperty('tunnel_stats') && Object.entries(tunnelStatus).length !== 0) {
      if (!this.status[machineId].tunnelStatus) {
        this.status[machineId].tunnelStatus = {};
      }

      // Generate tunnel notifications
      const tunnelStatusEntries = Object.entries(tunnelStatus);
      await Promise.all(tunnelStatusEntries.map(async entry => {
        const [tunnelID, tunnelState] = entry;
        const firstTunnelUpdate = !this.status[machineId].tunnelStatus[tunnelID];

        // Update changed tunnel status in memory by org
        if ((firstTunnelUpdate ||
          tunnelState.status !== this.status[machineId].tunnelStatus[tunnelID].status)) {
          this.setTunnelsStatusByOrg(org, tunnelID, machineId, tunnelState.status);
        }

        // Generate a notification if tunnel status has changed since the last update
        if ((firstTunnelUpdate ||
           tunnelState.status !== this.status[machineId].tunnelStatus[tunnelID].status)) {
          const targets = {
            deviceId,
            tunnelId: tunnelID,
            interfaceId: null
          };
          const resolved = tunnelState.status === 'up';
          const eventType = 'Tunnel connection';
          const notificationKey = await this.generateAlertKey(eventType, targets, resolved, org);

          const event = {
            org: org,
            title: tunnelState.status === 'up' ? '[resolved] Tunnel connection change'
              : 'Tunnel connection change',
            details: 'Tunnel ' + tunnelID + ' state changed to ' + (tunnelState.status === 'down'
              ? 'Not connected' : 'Connected'),
            targets,
            eventType,
            resolved
          };

          await this.saveEventToRedis(notificationKey, event);
        }
      }));
      Object.assign(this.status[machineId].tunnelStatus, rawStats.tunnel_stats);
    }

    // Set interface rx/tx rates in memory
    Object.keys(ifStats).forEach((ifc) => {
      devStats[ifc] = {};
      Object.keys(ifStats[ifc]).forEach((statKey) => {
        const mappedKey = this.statsFieldsMap.get(statKey);
        if (!mappedKey) return;
        devStats[ifc][mappedKey] = ifStats[ifc][statKey] / timeDelta;
      });
    });

    if (Object.entries(devStats).length !== 0) {
      this.setDeviceStatsField(machineId, 'ifStats', devStats);
    }
  }

  /**
     * Get devices status by ID
     * @param  {string} deviceID device host id
     * @return {Object}          details about the device status
     */
  getDeviceStatus (deviceID) {
    return this.status[deviceID];
  }

  /**
   * Remove devices status by ID
   * @param  {string} deviceID device host id
   * @return {void}
   */
  removeDeviceStatus (deviceID) {
    if (deviceID && this.status[deviceID]) {
      delete this.status[deviceID];
    }
  }

  /**
     * Retrieve the tunnel statistics for the specific device
     * @param {string} deviceID Device Id
     * @param {number} tunnelId Tunnel Id
     */
  getTunnelStatus (deviceID, tunnelId) {
    const isConnected = connections.isConnected(deviceID);
    if (!isConnected) {
      return null;
    }
    if (this.status[deviceID] && this.status[deviceID].state !== 'running') {
      return { status: 'down' };
    }
    if (this.status[deviceID] && this.status[deviceID].tunnelStatus) {
      return this.status[deviceID].tunnelStatus[tunnelId] || { status: 'down' };
    }
    return { status: 'down' };
  }

  /**
    * Removes the tunnel status for the specific device
    * @param {string} deviceID Device Id
    * @param {number} tunnelId Tunnel Id
    */
  clearTunnelStatus (deviceID, tunnelId) {
    if (this.status[deviceID] && this.status[deviceID].tunnelStatus &&
      this.status[deviceID].tunnelStatus[tunnelId]) {
      this.status[deviceID].tunnelStatus[tunnelId] = null;
    }
  }

  /**
     * Sets a specific field in the device status object
     * @param  {string} deviceID device host id
     * @param  {string} key      field name
     * @param  {any}    value    field value
     * @return {void}
     */
  setDeviceStatsField (deviceID, key, value) {
    if (!this.status[deviceID]) this.status[deviceID] = {};
    this.status[deviceID][key] = value;
  }

  /**
     * Updates the in-memory representation and the database
     * entries with the total number of bytes processed by the device.
     * @param  {string} org       device organization id
     * @param  {string} deviceID  device host id
     * @param  {Array}  statsList array of device statistics entries
     * @return {void}
     */
  updateUserDeviceStats (org, deviceID, statsList) {
    this.usersDeviceAggregatedStats.org = org;
    this.usersDeviceAggregatedStats.deviceID = deviceID;
    this.usersDeviceAggregatedStats.bytes = 0;

    statsList.forEach((statsEntry) => {
      const ifStats = statsEntry.stats;
      Object.keys(ifStats).forEach((ifc) => {
        this.usersDeviceAggregatedStats.bytes += ifStats[ifc].rx_bytes + ifStats[ifc].tx_bytes;
      });
    });

    if (this.usersDeviceAggregatedStats.bytes > 0) this.updateUsersDevicesStatsInDb();
  }

  /**
    * Updates the total number of bytes processed by a device
    * in the devices database.
    * @return {void}
    */
  async updateUsersDevicesStatsInDb () {
    // Clone the stats object to avoid overriding of the data by next updates
    const stats = Object.assign({}, this.usersDeviceAggregatedStats);
    const month = this.getCurrentMonth();

    // Update the database
    const org = stats.org;
    const device = stats.deviceID;
    const bytes = stats.bytes;

    // save account in order to keep relations between *deleted* orgs and accounts
    const { account } = await orgModel.findOne({ _id: org });

    try {
      const update = {
        $inc: { [`stats.orgs.${org}.devices.${device}.bytes`]: bytes },
        $set: { [`stats.orgs.${org}.account`]: account }
      };
      await deviceAggregateStats.findOneAndUpdate({ month: month }, update, {
        upsert: true,
        useFindAndModify: false
      });
    } catch (err) {
      logger.warn('Error storing aggregated device statistics to db',
        {
          params: { deviceId: device, bytes: bytes, err: err.message },
          periodic: { task: this.taskInfo }
        });
    }

    // Clear the in-memory orgs stats array to avoid duplicate counting
    this.usersDeviceAggregatedStats = {};
  }

  /**
     * Calculates the time stamp of the current month
     * @return {number} time stamp of the current month
     */
  getCurrentMonth () {
    // Set the date to the first day of the month, at 00:00:00
    const date = new Date();
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /**
     * @param  {string} deviceID the device host id
     * @return {number}          last time the device statistics
     *                           were updated in the database
     */
  getDeviceLastUpdateTime (deviceID) {
    return !this.status[deviceID]?.lastUpdateTime
      ? 0 : this.status[deviceID].lastUpdateTime;
  }

  /**
   * A callback that is called when a device disconnects from the MGMT
   * @param  {string} deviceID device host id
   * @return {void}
   */
  deviceConnectionClosed (deviceID) {
    this.removeDeviceStatus(deviceID);
  }

  /**
   * Sets the devices status information in memory by org
   * @param  {string} org       org id
   * @param  {string} deviceID  device id
   * @param  {string} status    status
   * @return {void}
   */
  setDevicesStatusByOrg (org, deviceID, status) {
    if (org && deviceID && status !== undefined) {
      if (!this.devicesStatusByOrg.hasOwnProperty(org)) {
        this.devicesStatusByOrg[org] = {};
      }
      this.devicesStatusByOrg[org][deviceID] = status;
    }
  }

  /**
   * Gets all organizations ids with updated devices status
   * @return {Array} array of org ids
   */
  getDevicesStatusOrgs () {
    return Object.keys(this.devicesStatusByOrg);
  }

  /**
   * Gets all devices with updated status of the org
   * @param  {string} org the org id
   * @return {Object} an object of devices ids of the org
   * or undefined if no updated statuses
   */
  getDevicesStatusByOrg (org) {
    return this.devicesStatusByOrg[org];
  }

  /**
   * Deletes devices status of the org in memory
   * @param  {string} org the org id
   * @return {void}
   */
  clearDevicesStatusByOrg (org) {
    if (org && this.devicesStatusByOrg.hasOwnProperty(org)) {
      delete this.devicesStatusByOrg[org];
    }
  }

  /**
   * Sets the tunnels status information in memory by org
   * @param  {string} org       org id
   * @param  {string} tunnelNum  tunnel's number
   * @param  {string} status    status
   * @return {void}
   */
  setTunnelsStatusByOrg (org, tunnelNum, machineId, status) {
    if (org && tunnelNum && status !== undefined) {
      if (!this.tunnelsStatusByOrg.hasOwnProperty(org)) {
        this.tunnelsStatusByOrg[org] = {};
      }
      if (!this.tunnelsStatusByOrg[org].hasOwnProperty(tunnelNum)) {
        this.tunnelsStatusByOrg[org][tunnelNum] = {};
      }
      this.tunnelsStatusByOrg[org][tunnelNum][machineId] = status;
    }
  }

  /**
   * Gets all organizations ids with updated tunnels status
   * @return {Array} array of org ids
   */
  getTunnelsStatusOrgs () {
    return Object.keys(this.tunnelsStatusByOrg);
  }

  /**
   * Gets all tunnels with updated status of the org
   * @param  {string} org the org id
   * @return {Object} an object of tunnels ids of the org
   * or undefined if no updated statuses
   */
  getTunnelsStatusByOrg (org) {
    return this.tunnelsStatusByOrg[org];
  }

  /**
   * Deletes tunnels status of the org in memory
   * @param  {string} org the org id
   * @return {void}
   */
  clearTunnelsStatusByOrg (org) {
    if (org && this.tunnelsStatusByOrg.hasOwnProperty(org)) {
      delete this.tunnelsStatusByOrg[org];
    }
  }

  /**
   * Called when a device status is received on the hosts channel from another server
   * @param  {string} machineId the machine id
   * @param  {object} status    new status of the device
   * @return {void}
   */
  statusCallback (machineId, status) {
    if (this.status[machineId]?.state !== status.state) {
      const deviceInfo = connections.getDeviceInfo(machineId);
      if (!deviceInfo) {
        logger.warn('Failed to get device info', {
          params: { machineId }
        });
        return;
      }
      const { org, deviceObj } = deviceInfo;
      this.setDevicesStatusByOrg(org, deviceObj, status.state);
    }
    this.status[machineId] = status;

    // Update changed tunnel status in memory by org
    if (status.tunnelStatus) {
      const { tunnelStatus } = status;
      const { org } = connections.getDeviceInfo(machineId) ?? {};
      for (const tunnelID in tunnelStatus) {
        this.setTunnelsStatusByOrg(org, tunnelID, machineId, tunnelStatus.status);
      }
    }
  }
}

var deviceStatus = null;
module.exports = function () {
  if (deviceStatus) return deviceStatus;
  else {
    deviceStatus = new DeviceStatus();
    return deviceStatus;
  }
};
