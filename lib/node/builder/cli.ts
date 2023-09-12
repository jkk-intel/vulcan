import { Command } from 'commander';
import { getDependencyErrors, getComponentsMap, orderBuildsInGroups } from './builder';
import { globalRoot } from 'ts-basis';

const cli = new Command();
const version = '0.0.1';

cli
.name('vulcan-build')
.description(`advanced project components building framework`)
.version(version);

const v1 = cli.command('v1');

v1.command('build')
.description(`build components with parameters, v1`)
.option(`-c, --components <components...>`)
.action(async (options: { components?: string[] }) => {
    const [ compoMap, fileErrors ] = await getComponentsMap();
    if (fileErrors) { for (const err of fileErrors) { console.error(err.e); } return; }
    const depErrors  = getDependencyErrors(compoMap);
    if (depErrors) { for (const err of depErrors) { console.error(err.e); } return; }
    const buildGroups = orderBuildsInGroups(compoMap);
    console.log(buildGroups);
});

cli.parse();

globalRoot.on('unhandledRejection', (e: Error, prom) => {
    console.error(e);
});
