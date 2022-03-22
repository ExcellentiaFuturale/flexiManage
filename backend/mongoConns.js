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

const configs = require('./configs')();
const mongoose = require('mongoose');
const logger = require('./logging/logging')({ module: module.filename, type: 'mongodb' });

class MongoConns {
  constructor () {
    this.getMainDB = this.getMainDB.bind(this);
    this.getAnalyticsDB = this.getAnalyticsDB.bind(this);

    this.mainDB = mongoose.createConnection(configs.get('mongoUrl'), {
      useNewUrlParser: true,
      useCreateIndex: true
    });
    this.mainDB.then((db) => {
      logger.info('Connected to MongoDB mainDB');
    }, (err) => { logger.error('Failed to connect to mainDB', { params: { err: err.message } }); });

    this.analyticsDB = mongoose.createConnection(configs.get('mongoAnalyticsUrl'), {
      useNewUrlParser: true,
      useCreateIndex: true
    });
    this.analyticsDB.then((db) => {
      logger.info('Connected to MongoDB analyticsDB');
    }, (err) => {
      logger.error('Failed to connect to analyticsDB', { params: { err: err.message } });
    });
  }

  getMainDB () {
    return this.mainDB;
  }

  /**
   * Run session based operation with the main database
   * @async
   * @param  {Function} func          Async function to be called as part of the transaction,
   *                                  this function get the session as a parameter
   * @param  {Boolean}  closeSession  Whether to end the session when the transaction completed
   *                                  or allow to the caller to close the session
   *                                  This is needed if some transaction objects are still used
   *                                  after the transaction completed
   * @param  {Number}   times         How many times to try in case of WriteConflict Mongo error
   * @return {Object}   session used  The session used, if closeSession is false, the session will
   *                                  be provided to the caller to close the session
   */
  async mainDBwithTransaction (func, closeSession = true, times = 3) {
    let execNum = 0;
    let session;
    try {
      session = await this.mainDB.startSession();
      await session.withTransaction(async () => {
        // Prevent infinite loop, if more than 'times' transient errors (writeConflict), exit
        execNum += 1;
        if (execNum > times) {
          throw new Error(`Error writing to database, too many attempts (${times})`);
        }
        await func(session);
      });
    } finally {
      // This creates an issue with some updates, need to understand why
      if (closeSession && session) session.endSession();
    }
    return session;
  }

  getAnalyticsDB () {
    return this.analyticsDB;
  }
}

var mongoConns = null;
module.exports = function () {
  if (mongoConns) return mongoConns;
  else {
    mongoConns = new MongoConns();
    return mongoConns;
  }
};
