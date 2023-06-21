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

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const mongoConns = require('../mongoConns.js')();

const targetsSchema = new Schema({
  deviceId: {
    type: Schema.Types.ObjectId,
    ref: 'devices',
    required: false
  },
  tunnelId: {
    type: String,
    required: false
  },
  interfaceId: {
    type: Schema.Types.ObjectId,
    ref: 'interfaces',
    required: false
  },
  policyId: {
    type: Schema.Types.ObjectId,
    ref: 'policies',
    required: false
  }
});

const alertInfoSchema = new Schema({
  value: {
    type: Number
  },
  threshold: {
    type: Number
  },
  unit: {
    type: String,
    enum: ['%', 'ms', 'C°']
  }
});

/**
 * Notifications Database Schema
 */
const notificationsSchema = new Schema({
  // organization
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  // account
  account: {
    type: Schema.Types.ObjectId,
    ref: 'accounts',
    required: true
  },
  // title
  title: {
    type: String,
    required: true
  },
  // timestamp
  time: {
    type: Date,
    required: true
  },
  // additional details, description
  details: {
    type: String,
    required: true
  },
  // notification status
  status: {
    type: String,
    required: true,
    default: 'unread'
  },
  count: {
    type: Number,
    required: false,
    default: 1
  },
  eventType: {
    type: String,
    required: false,
    enum: ['Device connection',
      'Running router',
      'Link/Tunnel round trip time',
      'Link/Tunnel default drop rate',
      'Device memory usage',
      'Hard drive usage',
      'Temperature',
      'Policy change',
      'Software update',
      'Interface connection',
      'Link status']
  },
  resolved:
  {
    type: Boolean,
    required: false,
    default: false
  },
  targets: {
    type: targetsSchema,
    required: false
  },
  severity: {
    type: String,
    required: true,
    enum: ['warning', 'critical', null],
    default: null
  },
  agentAlertsInfo: {
    type: alertInfoSchema,
    required: false,
    default: {}
  }
}, {
  timestamps: true
});

// Remove read notifications created more than a week ago
notificationsSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 604800,
    partialFilterExpression: { status: 'read' }
  }
);
notificationsSchema.index({ org: 1 });
notificationsSchema.index({ account: 1 });
notificationsSchema.index({ status: 1 });

// Default exports
module.exports = mongoConns.getAnalyticsDB().model('notifications', notificationsSchema);
