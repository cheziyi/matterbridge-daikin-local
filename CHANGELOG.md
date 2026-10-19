# Matterbridge Daikin Local changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.2] - 2026-10-19

### Fixed

- [devices]: Read the unit and write its state to Matter only while the Matter node is online. A poll that answered as the node went online, after a factory reset or at the start of the bridge, could hold the thermostat when the node writes its temperature, which failed the reset and left Matterbridge stuck. Only the read after a reset waited for the node before; every read does now, and nothing is written to the endpoints while the node is offline.

## [0.9.1] - 2026-10-19

### Changed

- [setup]: The Google Home preset shows no swing again and keeps it as it is, as the Apple Home preset does, instead of the rocking of the fan, or the switches on a unit whose fan speed cannot be set. The Full Matter support preset keeps the rocking.

## [0.9.0] - 2026-10-19

### Changed

- [devices]: Add the swing as the rocking of the fan control, a new choice named Native rocking beside the switches, the mode select and not shown: up and down for the vertical swing and left and right for the horizontal one, on the axes the unit swings on. The switches and the select take its place, so the fan control has no rocking beside them, as Apple Home is reported not to handle it well. The Google Home and the Full Matter support presets show the rocking, where they showed no swing and a mode select, or the switches on a unit whose fan speed cannot be set.

### Fixed

- [devices]: Write the state of the unit again after a factory reset of the Matter node once the node is back online, instead of as each endpoint comes back. A unit that answered at once held the thermostat as the node went online, which failed the reset and left Matterbridge stuck.

## [0.8.0] - 2026-10-19

### Changed

- [setup]: Name each air conditioner in its options in the setup page. The name starts as the one its adapter announces, with a number after it when another device has that name, such as `Bedroom 2`. A new name of the adapter no longer renames the device, and adapters that share a name can each be set up.
- [devices]: **Breaking:** give a switch, a mode select, a fan or a sensor that is a device of its own the serial number of its air conditioner with a dash before its letter, such as `A4:08:EA:CC:91:D4-V` in place of `A4:08:EA:CC:91:D4V`. A Matter app takes each of them for a new device.
- [setup]: Say after adding or removing an air conditioner that Matterbridge's own list of devices shows the change once its page is reloaded: Matterbridge does not tell its page when a plugin adds or removes a device.

### Fixed

- [devices]: Set the speed nearest the percent a Matter app sets, as the README says, instead of the one above it.
- [devices]: **Breaking:** the fan modes Low, Medium and High follow, since Matterbridge sets each to the middle percentage of its third: on a unit with Silent and Level 1 to 5 they set Silent, Level 2 and Level 4 instead of Level 1, Level 2 and Level 5, and with auto as the first step Low sets auto.

## [0.7.0] - 2026-10-15

### Added

- [devices]: Add the option to have a Matter mode the unit lacks run one of its modes, for Matter apps that offer only some of them, with nothing more added to Matter: Heat running dry on a unit that only cools, or Auto running fan. The air conditioner shows that mode, with its setpoint, while the unit is in the mode it runs. It is `modeReplacements`, from each mode of the unit to the mode it is shown as, such as `{ "dehumidify": "heat", "fan": "auto" }`, and goes with the mode switches or the mode select.
- [devices]: Add a switch for any mode of the unit, Auto, Cool and Heat among them, not only for dry and fan. Turning one of those three off turns the unit off. The setup page picks the switches with a compact list.

### Changed

- [package]: Use daikin-local-control 0.6.1: a classic adapter is sent its setpoint rounded to the whole degree, and a DSIOT adapter rounds it to the nearest half degree instead of down. Its clients close with `dispose`, which the plugin calls where it called `close`, and send nothing once disposed.
- [setup]: Call the swing on both axes at once 3D swing: `3D` on the swing mode select in Matter instead of `Both`, and `3D swing` in the setup page.
- [setup]: Start a new air conditioner with the Apple Home preset in the setup page, instead of choices that matched no preset.
- [setup]: The Apple Home and Google Home presets add a switch for each of the dry and fan modes the unit has, since both apps are reported to offer only off, cool, heat and auto.
- [devices]: Give a fan of its own an on/off that follows the power of the air conditioner, so that a Matter app does not show the fan running while the unit is off. Turning the fan on or off turns the air conditioner on or off, and the fan keeps showing the speed the unit holds. A command that turns the unit off leaves its fan speed as it is, since an app that turns a fan off sets its speed to 0 as well.

### Fixed

- [devices]: Put a setpoint a Matter app changes while the unit is in dry or fan back to what it showed, since neither mode takes one, instead of leaving the app showing a setpoint the unit never took.
- [devices]: Keep taking the commands of a Matter app after the bridge is removed from the last app it was in and paired again. Matter resets the bridge to factory defaults when its last app leaves, which dropped what the plugin listens to on each endpoint, so that commands reached nothing until Matterbridge was restarted. The plugin now listens again once each endpoint is back, and writes the state of the unit to it.

## [0.6.0] - 2026-10-14

### Added

- [devices]: Add the option to make the auto fan speed the first or the last step of the fan speed, for Matter apps that show no auto fan mode. First is step 1 or the bottom of the slider, last is the top step or 100 %, and the speeds of the unit share the rest.

### Changed

- [devices]: A Matter app turning the fan to off or 0 sets the first step of the fan speed, the slowest speed or auto when auto is the first step, instead of being ignored. Every Matter fan control has an off position below its first step, and an air conditioner has no fan-off.
- [setup]: Choose where auto is in Matter in one place in the setup page: the native Auto fan mode, a switch beside it, or the first or the last step of the fan speed in place of it. The Apple Home and Google Home presets pick the switch.
- [setup]: Choose how the dry and fan modes appear in one place in the setup page: the native Matter modes of the air conditioner only, a mode select, or a switch for each picked mode.
- [config]: **Breaking:** the `hasDryModeSwitch`, `hasFanModeSwitch` and `hasModeSelect` settings of a stored device are replaced by `modeControl`, which is `native`, `select` or `switches`, and `modeSwitches`, which lists `dehumidify`, `fan` or both while `modeControl` is `switches`. A device stored with a mode switch or a mode select comes back with the native modes only: choose them again in the setup page.
- [config]: **Breaking:** the `hasFanAutoSwitch` setting of a stored device is replaced by `fanAutoControl`, which is `native`, `switch`, `firstStep` or `lastStep`. A device stored with the auto fan switch comes back with the native Auto fan mode instead: choose the switch again in the setup page.
- [setup]: Make the parts of the air conditioner a choice of the presets. The Full Matter support preset makes the switches, a fan of its own and a humidity sensor of its own parts of one composed device, and the Apple Home and Google Home presets make each of them a device of its own, since neither app is known to show the parts of a composed device well. A preset now shows as chosen only while that choice matches too.
- [setup]: Replace the Full and Minimal presets with a Full Matter support preset, for apps that show every Matter control: fan speed as steps with its auto mode, the swing as a mode select, a switch for each special mode and the outdoor temperature sensor, all as one composed device. The Apple Home and Google Home presets no longer add the dry and fan mode switches, and the Google Home preset adds the humidity sensor of its own, as the Apple Home preset does. Both leave the swing out of Matter and as it is, instead of adding a switch for each axis.

## [0.5.0] - 2026-10-14

### Added

- [devices]: Add the option of a mode select for the mode instead of the dry and fan mode switches, which picks Off or any mode of the unit as the thermostat mode does, on a unit with a dry or a fan mode. The swing can be a mode select instead of the switches too. No preset adds them: few Matter apps show a mode select. Home Assistant does, Apple Home does not.

### Changed

- [sensors]: Keep the humidity on the air conditioner when it is also on a humidity sensor of its own, as the room temperature is, so that the sensor is an addition for the Matter apps that show no humidity on an air conditioner.
- [sensors]: Make the outdoor temperature sensor a device of its own even when the air conditioner is a composed device, so that it can be put in another room of a Matter app instead of reporting the outdoor temperature for the room of the air conditioner. On an air conditioner that had the sensor as a part, the sensor comes back as a new device.

## [0.4.0] - 2026-10-14

### Added

- [devices]: Expose each air conditioner as one composed device in Matter: its switches, a fan of its own and its sensors are parts of the air conditioner, and move between the rooms of a Matter app with it. Each switch is tagged with a number and with what it is. The setup page can make each of them a device of its own instead, as before.
- [sensors]: Add the option to show the humidity on a humidity sensor of its own instead of on the air conditioner, for Matter apps that show no humidity there. The Apple Home preset turns it on.
- [sensors]: Add the option to show the outdoor temperature on a sensor. It is off unless you or the Full preset turn it on, because a Matter app may take it for the temperature of the room.
- [readme]: Add diagrams of how an air conditioner is built in Matter, and the device types it uses.

### Changed

- [devices]: A device stored by an earlier version is a composed device without an outdoor temperature sensor, and is built again in Matter. A Matter app may take its switches, its fan and its sensors for new devices.

## [0.3.0] - 2026-10-13

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
