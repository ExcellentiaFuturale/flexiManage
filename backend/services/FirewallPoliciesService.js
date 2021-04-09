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
/* eslint-disable no-unused-vars */
const Service = require('./Service');
const createError = require('http-errors');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const FirewallPolicies = require('../models/firewallPolicies');
const { devices } = require('../models/devices');
const { ObjectId } = require('mongoose').Types;

class FirewallPoliciesService {
  static async verifyRequestSchema (firewallPolicyRequest, org) {
    const inboundRuleTypes = ['edgeAccess', 'portForward', 'nat1to1'];
    const { _id, name, rules } = firewallPolicyRequest;
    for (const rule of rules) {
      const { direction, inbound } = rule;
      // Inbound rule type must be specified
      if (direction === 'inbound' && !inboundRuleTypes.includes(inbound)) {
        return {
          valid: false,
          message: 'Wrong inbound rule type'
        };
      }
      for (const [side, { trafficTags, ipPort, ipProtoPort }]
        of Object.entries(rule.classification)) {
        // Only ip, ports and protocols allowed for inbound rule destination
        if (!ipProtoPort && side === 'destination' && direction === 'inbound') {
          return {
            valid: false,
            message: 'Only ip, ports and protocols allowed for inbound rule destination'
          };
        }
        // Ip, ports and protocols must be specified for the destination
        if (ipPort && side === 'destination') {
          return {
            valid: false,
            message: 'Ip, ports and protocols must be specified for the destination'
          };
        }
        // Only ip and ports without protocols can be specified for the source
        if (ipProtoPort && side === 'source') {
          return {
            valid: false,
            message: 'Only IP and ports without protocols can be specified for the source'
          };
        }
        // Empty (ip, ports, protocol) not allowed
        if (ipPort) {
          const { ip, ports } = ipPort;
          if (!(ip || ports)) {
            return {
              valid: false,
              message: 'IP or ports must be provided'
            };
          }
        };
        if (ipProtoPort) {
          const { ip, ports, protocols } = ipProtoPort;
          if (!(ip || ports || (Array.isArray(protocols) && protocols.length))) {
            return {
              valid: false,
              message: 'IP, ports or protocols must be provided'
            };
          }
        };

        if (trafficTags) {
          // Traffic Tags not allowed for source
          if (side === 'source') {
            return {
              valid: false,
              message: 'Traffic Tags not allowed for source'
            };
          }
          const { category, serviceClass, importance } = trafficTags;
          // Empty Traffic Tags not allowed
          if (!(category || serviceClass || importance)) {
            return {
              valid: false,
              message: 'Category, service class or importance must be provided'
            };
          }
        }
      }
    };

    // Duplicate names are not allowed in the same organization
    const hasDuplicateName = await FirewallPolicies.findOne(
      { org, name, _id: { $ne: _id } }
    );
    if (hasDuplicateName) {
      return {
        valid: false,
        message: 'Duplicate names are not allowed in the same organization'
      };
    };

    return { valid: true, message: '' };
  }

  /**
   * Get all Firewall policies
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * org String Organization to be filtered by (optional)
   * returns List
   **/
  static async firewallPoliciesGET ({ offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const firewallPolicies = await FirewallPolicies.find(
        { org: { $in: orgList } },
        {
          name: 1,
          description: 1,
          isDefault: 1,
          rules: 1
        }
      )
        .lean()
        .skip(offset)
        .limit(limit);

      const converted = JSON.parse(JSON.stringify(firewallPolicies));
      return Service.successResponse(converted);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete a Firewall policy
   *
   * id String Numeric ID of the Firewall policy to delete
   * no response value expected for this operation
   **/
  static async firewallPoliciesIdDELETE ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Don't allow deleting a policy if it's
      // installed on at least one device
      const count = await devices.countDocuments({
        'policies.firewall.policy': id,
        'policies.firewall.status': { $in: ['installing', 'installed'] },
        org: { $in: orgList }
      });

      if (count > 0) {
        const message = 'Cannot delete a policy that is being used';
        return Service.rejectResponse(message, 400);
      }

      await devices.updateMany({
        org: { $in: orgList },
        'policies.firewall.policy': id,
        'policies.firewall.status': { $nin: ['installing', 'installed'] }
      }, {
        $set: {
          'policies.firewall.policy': null,
          'policies.firewall.status': '',
          'policies.firewall.requestTime': null
        }
      });

      const { deletedCount } = await FirewallPolicies.deleteOne({
        org: { $in: orgList },
        _id: id
      });

      if (deletedCount === 0) {
        return Service.rejectResponse('Not found', 404);
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
   * Get a Firewall policy by id
   *
   * id String Numeric ID of the Firewall policy to retrieve
   * org String Organization to be filtered by (optional)
   * returns FirewallPolicy
   **/
  static async firewallPoliciesIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const firewallPolicy = await FirewallPolicies.findOne(
        {
          org: { $in: orgList },
          _id: id
        },
        {
          name: 1,
          description: 1,
          isDefault: 1,
          rules: 1
        }
      )
        .lean();

      if (!firewallPolicy) {
        return Service.rejectResponse('Not found', 404);
      }

      const converted = JSON.parse(JSON.stringify(firewallPolicy));
      return Service.successResponse(converted);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify a Firewall policy
   *
   * id String Numeric ID of the Firewall policy to modify
   * firewallPolicyRequest FirewallPolicyRequest  (optional)
   * returns FirewallPolicy
   **/
  static async firewallPoliciesIdPUT ({ id, org, firewallPolicyRequest }, { user }) {
    try {
      const { name, description, isDefault, rules } = firewallPolicyRequest;
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Verify request schema
      const { valid, message } = await FirewallPoliciesService.verifyRequestSchema(
        firewallPolicyRequest, orgList[0]
      );
      if (!valid) {
        throw createError(400, message);
      }

      // only one default policy per organization is allowed
      if (isDefault) {
        await FirewallPolicies.update(
          { org: { $in: orgList }, _id: { $ne: id }, isDefault: true },
          { $set: { isDefault: false } },
          { upsert: false }
        );
      };

      const firewallPolicy = await FirewallPolicies.findOneAndUpdate(
        {
          org: { $in: orgList },
          _id: id
        },
        {
          org: orgList[0].toString(),
          name: name,
          description: description,
          isDefault: isDefault,
          rules: rules
        },
        {
          fields: {
            name: 1,
            description: 1,
            isDefault: 1,
            rules: 1
          },
          new: true
        }
      )
        .lean();

      if (!firewallPolicy) {
        return Service.rejectResponse('Not found', 404);
      }

      const converted = JSON.parse(JSON.stringify(firewallPolicy));
      return Service.successResponse(converted);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get all Firewall policies names and IDs only
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * org String Organization to be filtered by (optional)
   * returns List
   **/
  static async firewallPoliciesListGET ({ offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const firewallPolicies = await FirewallPolicies.find(
        { org: { $in: orgList } },
        { name: 1, isDefault: 1 }
      )
        .skip(offset)
        .limit(limit);

      return Service.successResponse(firewallPolicies);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Add a new Firewall policy
   *
   * firewallPolicyRequest FirewallPolicyRequest
   * org String Organization to be filtered by (optional)
   * returns FirewallPolicy
   **/
  static async firewallPoliciesPOST ({ firewallPolicyRequest, org }, { user }) {
    try {
      const { name, description, isDefault, rules } = firewallPolicyRequest;
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Verify request schema
      const { valid, message } = await FirewallPoliciesService.verifyRequestSchema(
        firewallPolicyRequest, orgList[0]
      );
      if (!valid) {
        throw createError(400, message);
      }

      // only one default policy per organization is allowed
      if (isDefault) {
        await FirewallPolicies.update(
          { org: { $in: orgList }, isDefault: true },
          { $set: { isDefault: false } },
          { upsert: false }
        );
      };

      const result = await FirewallPolicies.create({
        org: orgList[0].toString(),
        name: name,
        description: description,
        isDefault: isDefault,
        rules: rules
      });

      const firewallPolicy = (({ _id, name, description, isDefault, rules }) => ({
        _id,
        name,
        description,
        isDefault,
        rules
      }))(result);

      const converted = JSON.parse(JSON.stringify(firewallPolicy));
      return Service.successResponse(converted, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get all Firewall policies metadata
   *
   * offset Integer The number of items to skip before
   * starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * org String Organization to be filtered by (optional)
   * returns List
   **/
  static async firewallPoliciesMetaGET ({ offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // Fetch all Firewall policies of the organization.
      // To each policy, attach the installation status of
      // each of the devices the policy is installed on.
      const firewallPoliciesMeta = await FirewallPolicies.aggregate([
        { $match: { org: { $in: orgList.map(org => ObjectId(org)) } } },
        {
          $project: {
            _id: 1,
            name: 1,
            isDefault: 1,
            description: 1
          }
        },
        {
          $lookup: {
            from: 'devices',
            let: { id: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$policies.firewall.policy', '$$id'] } } },
              { $project: { 'policies.firewall': 1 } }
            ],
            as: 'firewallPolicy'
          }
        },
        { $addFields: { statuses: '$firewallPolicy.policies.firewall.status' } },
        {
          $project: {
            _id: { $toString: '$_id' },
            name: 1,
            description: 1,
            isDefault: 1,
            statuses: 1
          }
        }
      ]).allowDiskUse(true);

      const response = firewallPoliciesMeta.map(policy => {
        const installCount = {
          installed: 0,
          pending: 0,
          failed: 0,
          deleted: 0
        };
        policy.statuses.forEach(policyStatus => {
          if (policyStatus === 'installed') {
            installCount.installed++;
          } else if (['installing', 'uninstalling'].includes(policyStatus)) {
            installCount.pending++;
          } else if (policyStatus.includes('fail')) {
            installCount.failed++;
          } else if (policyStatus.includes('deleted')) {
            installCount.deleted++;
          }
        });
        const { statuses, ...rest } = policy;
        return {
          ...rest,
          installCount
        };
      });
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = FirewallPoliciesService;
