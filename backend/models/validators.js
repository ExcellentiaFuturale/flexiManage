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

const net = require('net');
const email = require('isemail');
const urlValidator = require('valid-url');
const validator = require('validator');
const filenamify = require('filenamify');
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();

// Globals
const protocols = ['OSPF', 'NONE', 'BGP', 'OSPF,BGP'];
const interfaceTypes = ['WAN', 'LAN', 'TRUNK', 'NONE'];

// Helper functions
const isEmpty = (val) => { return val === null || val === undefined; };
const isValidURL = (url) => { return urlValidator.isUri(url) !== undefined; };
const isValidFileName = (name) => {
  return !isEmpty(name) && name !== '' && filenamify(name) === name;
};
const validateIsInteger = val => /^[1-9]\d+|^\d$/.test(val);

const validateIsPhoneNumber = (number) => {
  try {
    if (isEmpty(number) || number === '') return false;
    return phoneUtil.isValidNumber(phoneUtil.parse(number));
  } catch (err) {

  }
};
const validateDHCP = dhcp => ['yes', 'no'].includes(dhcp);

// Accept empty IP address values, as they are not mandatory at registration time
const validateIPv4 = (ip) => { return ip === '' || net.isIPv4(ip); };
const validateIPv4WithMask = field => {
  const [ip, mask] = field.split('/');
  return validateIPaddr(ip) && validateIPv4Mask(mask);
};
const validateIPv4Mask = mask => {
  return (
    !isEmpty(mask) &&
    mask.length < 3 &&
    !isNaN(Number(mask)) &&
    mask >= 0 && mask <= 32
  );
};
const validateIPv6Mask = mask => {
  return (
    !isEmpty(mask) &&
    mask.length < 4 &&
    !isNaN(Number(mask)) &&
    mask >= 0 && mask <= 128
  );
};
const validateIPv6 = (ip) => { return ip === '' || net.isIPv6(ip); };
const validateIPaddr = (ip) => { return validateIPv4(ip) || validateIPv6(ip); };
const validateDevId = (devId) => {
  return (
    validatePciAddress(devId) ||
    validateUsbAddress(devId) ||
    validateVlanAddress(devId)
  );
};
const validateParentDevId = (devId) => {
  return (
    validatePciAddress(devId) ||
    validateUsbAddress(devId)
  );
};
const validatePciAddress = pci => {
  return (
    pci === '' ||
    /^pci:([A-F0-9]{2,4}:)?([A-F0-9]{2}|[A-F0-9]{4}):[A-F0-9]{2}\.[A-F0-9]{2}$/i.test(
      pci
    )
  );
};
const validateUsbAddress = usb => {
  return (
    usb === '' ||
    /^usb:usb[0-9]\/[0-9]+-[0-9]+\/[0-9]+-[0-9]+:[0-9]+\.[0-9]+$/i.test(usb) ||
    /* eslint-disable max-len */
    /^usb:usb[0-9]\/[0-9]+-[0-9]+\/[0-9]+-[0-9]+.[0-9]+\/[0-9]+-[0-9]+.[0-9]:[0-9].[0-9]+$/i.test(usb)
  );
};
const validateVlanAddress = devId => {
  return (
    devId === '' ||
    /* eslint-disable max-len */
    /^vlan\.([1-9]|[1-9][0-9]{1,2}|[1-3][0-9]{1,3}|40([0-8][0-9]|9[0-4]))\.pci:([A-F0-9]{2,4}:)?([A-F0-9]{2}|[A-F0-9]{4}):[A-F0-9]{2}\.[A-F0-9]{2}$/i.test(devId)
  );
};
const validateIfcName = (name) => { return /^[a-zA-Z0-9_/.]{1,64}$/i.test(name || ''); };
const validateIsNumber = (str) => { return !isNaN(Number(str)); };
const validateDriverName = (name) => { return /^[a-z0-9_-]{1,30}$/i.test(name || ''); };
const validateMacAddress = mac => {
  return /^(([A-F0-9]{2}:){5}[A-F0-9]{2})|(([A-F0-9]{2}-){5}[A-F0-9]{2})$/i.test(
    mac
  );
};
const validateRoutingProto = protocol => {
  return !isEmpty(protocol) && protocols.includes(protocol.toUpperCase());
};
const validateIfcType = type => {
  return !isEmpty(type) && interfaceTypes.includes(type.toUpperCase());
};

const validateDeviceName = name => {
  return name === '' || /^[a-z0-9-_ .!#%():@[\]]{1,50}$/i.test(name || '');
};
const validateDescription = desc => {
  return desc === '' || /^[a-z0-9-_ .!#%():@[\]]{1,50}$/i.test(desc || '');
};
const validateDeviceSite = site => {
  return site === '' || /^[a-z0-9-_ .!#%():@[\]]{1,50}$/i.test(site || '');
};

// Hostname validation according to RFC 952, RFC 1123
// Allow also underscore as some systems allow it
const validateHostName = (name) => { return /^[a-z0-9-_.]{1,253}$/i.test(name || ''); };
const validateIpList = (list) => {
  if (isEmpty(list)) return false;

  const IpArr = list !== '' ? list.replace(/\s/g, '').split(',') : [];
  for (const ip of IpArr) {
    if (!net.isIPv4(ip) && !net.isIPv6(ip)) return false;
  }

  return true;
};
const isPort = (val) => {
  return !isEmpty(val) && !(val === '') && validateIsInteger(+val) && val >= 0 && val <= 65535;
};
const validatePort = port => port === '' || isPort(port);
const validateVxlanPort = port => validatePort(port) && port !== '500' && port !== '4500';
const validatePortRange = (range) => {
  if (range === '') return true;
  if (!(range || '').includes('-')) return isPort(range);

  const [portLow, portHigh] = (range || '').split('-');
  return isPort(portLow) && isPort(portHigh) && (+portLow < +portHigh);
};
const validateMachineID = (id) => { return /^[a-f0-9-]{1,50}$/i.test(id || ''); };
const validateSerial = (id) => {
  return (id !== null) &&
  (id !== undefined) &&
  /^[a-z0-9-_ .#%/():[\]]{0,250}$/i.test(id || '');
};
const validateTokenName = (name) => { return /^[a-z0-9-_ .!#%():@[\]]{3,15}$/i.test(name || ''); };

const validateURL = (url) => { return !isEmpty(url) && isValidURL(url); };
const validateFileName = (name) => { return isValidFileName(name); };
const validateFieldName = (name) => { return /^[a-z0-9-. ]{1,100}$/i.test(name || ''); };

const validateUserName = name => {
  return (
    !isEmpty(name) &&
    (email.validate(name) || /^[a-z0-9-. ]{2,15}$/i.test(name))
  );
};
const validateEmail = (mail) => { return !isEmpty(mail) && email.validate(mail); };

const validateLabelName = (name) => { return /^[a-z0-9-_ .:]{3,30}$/i.test(name || ''); };
const validateLabelColor = (color) => { return /^#[0-9A-F]{6}$/i.test(color); };

const validatePolicyName = (name) => { return /^[a-z0-9-_ .:]{3,50}$/i.test(name || ''); };
const validateRuleName = (name) => { return /^[a-z0-9-_ .:]{3,15}$/i.test(name || ''); };

const validateMetric = (val) => val === '' || (val && validateIsInteger(val) && +val >= 0);
const validateMtu = (val) => val && validateIsInteger(val) && +val >= 500 && +val <= 9999;
const validateOSPFArea = (val) => val !== null && (validateIPv4(val) || (validateIsInteger(val) && +val >= 0));
const validateOSPFCost = (val) => val === null || (validateIsInteger(val) && +val >= 0 && +val < 65535);
const validateOSPFInterval = val => val && validateIsInteger(val) && +val >= 1 && +val < 65535;
const validateFQDN = val => val && validator.isFQDN(val);
const validateStringNoSpaces = str => { return str === '' || /^\S+$/i.test(str || ''); };
const validateApplicationIdentifier = str => { return /[A-Za-z_.-]/i.test(str || ''); };
const validateBGPASN = val => val && validateIsInteger(val) && +val >= 1;
const validateBGPInterval = val => val && validateIsInteger(val) && +val >= 0 && +val < 65535;
const validateCpuCoresNumber = val => val && validateIsInteger(val) && +val >= 1 && +val < 65535;
const validateVlanTag = val => val === '' || (val && validateIsInteger(val) && +val >= 0 && +val <= 4096);

module.exports = {
  validateDHCP,
  validateIPv4,
  validateIPv4WithMask,
  validateIPv6,
  validateIPaddr,
  validatePciAddress,
  validateDevId,
  validateParentDevId,
  validateVlanTag,
  validateIfcName,
  validateIPv4Mask,
  validateIPv6Mask,
  validatePort,
  validatePortRange,
  validateDriverName,
  validateMacAddress,
  validateRoutingProto,
  validateIfcType,
  validateDeviceName,
  validateDescription,
  validateDeviceSite,
  validateHostName,
  validateIpList,
  validateMachineID,
  validateSerial,
  validateTokenName,
  validateURL,
  validateFileName,
  validateFieldName,
  validateUserName,
  validateEmail,
  validateIsPhoneNumber,
  validateLabelName,
  validateLabelColor,
  validatePolicyName,
  validateRuleName,
  validateMetric,
  validateMtu,
  validateIsInteger,
  validateOSPFArea,
  validateOSPFCost,
  validateOSPFInterval,
  validateFQDN,
  validateStringNoSpaces,
  validateApplicationIdentifier,
  validateBGPASN,
  validateBGPInterval,
  validateIsNumber,
  validateCpuCoresNumber,
  validateVxlanPort
};
