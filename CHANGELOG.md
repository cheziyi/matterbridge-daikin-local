# Matterbridge Daikin Local changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - Unreleased

### Changed

- [devices]: Use the MAC address of the adapter as the serial number of a device in Matter, where a code made from it was used. A device set up with an earlier version is built again in Matter, and a Matter app may take it for a new device.
- [setup]: Remove a device by the MAC address of its adapter, where its name was used.

### Fixed

- [readme]: Say that a renamed adapter is built again in Matter and may be taken for a new device, where the README said it stays the same device.

## [0.2.0] - 2026-10-13

### Added

- [airbase]: Support the Airbase adapter (BRP15B61) of a ducted unit, found by a search or added by address: power, mode, target temperature, fan speed and swing. Its zones, its fan auto and its airside are not exposed.
- [discovery]: Follow a stored Airbase device to a new address and a new name when a search reports its adapter as classic, which a search does for an Airbase adapter that was too slow to say which of the two it is.

### Changed

- [package]: Use daikin-local-control 0.5.0: it adds the Airbase client, and a search tells an Airbase adapter from a classic one.
- [setup]: Speak of the Daikin app an adapter was set up with, in the setup page and in the README, where both named the DAIKIN Mobile Controller app alone: the adapters of the Daikin Airbase and ONECTA apps are supported as well.
- [readme]: Add the npm, build, CodeQL, coverage and license badges.

## [0.1.0] - 2026-10-13

### Added

- [platform]: Expose Daikin air conditioners to Matter over the local network with [daikin-local-control](https://www.npmjs.com/package/daikin-local-control): power, mode, target temperature and room temperature.
- [setup]: Add a guided setup in the plugin frontend: discover adapters or add one by address, register with the KEY or enter the child lock code where an adapter requires it, and choose how the fan and the swing appear.
- [devices]: Identify each device by the MAC address of its adapter, and follow it to a new address and a new name. Devices are added, changed and removed without restarting Matterbridge.
- [devices]: Check after each start what every unit accepts, and build a device again in Matter when its modes, fan speeds, swing or setpoint ranges changed.
- [devices]: Keep a stored device this version cannot read in the configuration, until a device with its name or its MAC address is added in the setup page.
- [devices]: Log a stored setting that is not valid when its default is used instead.
- [platform]: Add the setting `maxStateAgeForCommandInSeconds`: how old the state of the last poll may be for a command to be built from it without reading the unit first.
- [discovery]: Search the network at start, every 5 minutes and when a device stops answering, and update the address of each stored device found at a new one.
- [sensors]: Show the indoor humidity on the air conditioner and the outdoor temperature on a sensor of its own, from the first time a unit gives each. A reading the unit does not give shows no value, the room temperature included.
- [fan]: Expose the fan speed as steps or as a percentage, or hide it and keep or fix the speed.
- [fan]: Add the option to show the fan speed on a fan of its own instead of on the air conditioner, for Matter apps that show no fan speed there.
- [swing]: Expose the swing as one switch for each axis, or hide it and keep or fix the mode.
- [modes]: Add an optional switch for the dry mode and one for the fan mode, for Matter apps that do not offer those modes.
- [fan]: Add an optional switch for the auto fan speed, for Matter apps that show no auto fan mode.
- [special modes]: Add an optional switch for each of Powerful, Econo and Streamer that a unit reports, on classic and on DSIOT adapters.
- [setup]: Add the Apple Home, Google Home, Full and Minimal presets to the options of a device.

### Changed

- [package]: Require Node.js 22.19 or later, as daikin-local-control does.
- [package]: Use daikin-local-control 0.4.0: one request reads state and sensors on a BRP084, a command is built from the last poll instead of reading the unit first, an adapter added by address tells its name and its MAC address on both adapter types, and a BRP084 turns special modes on and off.
- [config]: Store the Terminal ID as 32 lowercase hexadecimal digits, the only form daikin-local-control 0.4.0 takes. The config editor refuses any other form, and an ID stored with dashes or in upper case is stored again without them.
