## Chip tests

The Matter CHIP conformance tests run against this plugin inside the `luligu/matterbridge:chip-test` container, driven by [scripts/run-chip-tests.mjs](./scripts/run-chip-tests.mjs) and configured by [chipTests.json](./chipTests.json). How the harness works is in [.agents/rules/chip-tests.instructions.md](./.agents/rules/chip-tests.instructions.md).

### What the configured tests cover

The plugin builds the Matter endpoints of an air conditioner from what its unit answers, and the container reaches no unit. `chipTests.json` therefore starts the plugin with no devices, so the bridge exposes its root node and its aggregator alone, and the three generic tests check the composition, the conformance and the default warnings of that node. They cover none of the clusters of an air conditioner: see [Testing an air conditioner](#testing-an-air-conditioner).

### Create and start the container (Linux, macOS, and Windows)

Run the `luligu/matterbridge:chip-test` docker image:

- frontend on port 8585
- plugin mapped to .
- container test logs directory mapped on ./temp directory

```shell
node scripts/run-chip-tests.mjs --start
```

### Run all configured tests inside the container

```shell
node scripts/run-chip-tests.mjs
```

### Manually run the tests inside the container

Open a shell in the container

```shell
docker exec -it chip-test bash
```

In the shell:

```bash
# Generic device composition and conformance
python3 src/python_testing/TC_DeviceBasicComposition.py
python3 src/python_testing/TC_DeviceConformance.py
python3 src/python_testing/TC_DefaultWarnings.py --bool-arg pixit_allow_default_vendor_id:true
```

### Stop the container

```shell
node scripts/run-chip-tests.mjs --stop
```

### Testing an air conditioner

The cluster tests need an adapter the container can reach: a unit on the network of the Docker host, or a [simulator of daikin-local-control](https://github.com/cheziyi/daikin-local-control#simulators) started on that host. Then:

1. Add the device to `config.devices` in `chipTests.json` as the plugin stores it: `name`, `macAddress`, `host` and `protocol`, and `requiresRegistration`, `usesHttps`, `requiresLocalPassword` and `localPassword` when the adapter asks for them (see `parseDeviceConfig` in [src/config.ts](./src/config.ts)). The harness writes `config` to the container as it is, so a classic adapter that asks for its KEY needs the `terminalUuid` it has registered in `config` too.
2. Start the container and read the endpoint numbers with the wildcard read of section 4 of the harness guide rather than counting: Matter numbers the endpoints in the order they are registered and keeps the numbers in the node storage afterwards. The plugin registers each stored device in turn, and for one device the air conditioner first, then the fan, the swing, mode, auto fan and special mode switches, the mode and swing selects and the humidity sensor, and the outdoor temperature sensor last. A composed device has those as child endpoints of the air conditioner instead, apart from the outdoor temperature sensor.
3. Add the tests to `chipTests.json` with `--endpoint` set accordingly, and a `chip:test:<cluster>` script to `package.json` for each cluster.

What an air conditioner exposes, so which clusters have tests to run, is in the README under [How it is built in Matter](./README.md#how-it-is-built-in-matter): the Thermostat with the Heating, Cooling and Auto Mode features of the unit (`TSTAT`), the Fan Control with the Multi Speed, Auto and Rocking features as configured (`FAN`), On/Off on the air conditioner, the fan and every switch (`OO`), Mode Select on the selects (`MOD`), Relative Humidity Measurement and Temperature Measurement on the sensors (`RH`, `TM`) and Bridged Device Basic Information on every device (`BRBINFO`). Find the runnable YAML and Python tests of each with the two list commands of section 5 of the harness guide. The curated `/root/matterbridge.pics` of the image has no Thermostat section, and the generic `ci-pics-values` overclaims the Presets and Thermostat Suggestions features, so the Thermostat tests need a PICS overlay of their own with `TSTAT.S=1` and the features of the unit's thermostat. The plugin template's overlay for a Heating + Cooling + Auto Mode thermostat, which this repository no longer carries, is in its history as `thermostat.pics` and is a starting point for a unit that both heats and cools.
