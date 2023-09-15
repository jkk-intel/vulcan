import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { promise } from 'ts-basis';
import { ComponentManifest, ComponentManifestMap } from './model';
const fg = require('fast-glob');

type ManifestError = {file: any; e: Error; data?: any; };

function getFileContent(file: string, errors: ManifestError[]) {
    return promise<{file: string, data: string}>(async (resolve) => {
        fs.readFile(file, 'utf8', (e, data) => {
            if (e) { errors.push({ file, e }); return resolve(null); }
            return resolve({ file, data });
        });
    });
}

export function getComponentsMap(currentPath = '.') {
    return promise<[ComponentManifestMap, ManifestError[]]>(async resolve => {
        const map: ComponentManifestMap = {};
        const errors: ManifestError[] = [];
        const globExpr = ['!node_modules', `${currentPath}/**/component.yml`];
        fg(globExpr).then(async (ymlFiles: string[]) => {
            const proms = ymlFiles.map(filename => getFileContent(filename, errors));
            for (const res of await Promise.allSettled(proms)) {
                if (res.status !== 'fulfilled') { continue; }
                const { file, data } = res.value;
                try {
                    const compo = yaml.load(data) as ComponentManifest;
                    compo.manifest_path = file;
                    if (!compo.name) {
                        errors.push({file, e: new Error(`ERROR: component name not found\n    ${file}`)});
                        continue;
                    }
                    if (!compo.project) { compo.project = ''; }
                    compo.fullname = `${compo.project}/${compo.name}`;
                    if (map[compo.fullname]) {
                        errors.push({file, e: new Error(
                            `ERROR: component name '${compo.fullname}' exists already\n    at ${file} ` +
                            `(registered by ${map[compo.fullname].manifest_path})`)});
                        continue;
                    }
                    map[compo.fullname] = compo;
                    if (compo.depends_on && typeof compo.depends_on === 'string') {
                        compo.depends_on = [ compo.depends_on ];
                    }
                    if (!compo._circular_dep_checker) { compo._circular_dep_checker = []; }
                } catch (e) {
                    errors.push({file, e: new Error(`ERROR: unable to yaml parse\n    ${file}: ${e}`)});
                    continue;
                }
            }
            return resolve([map, errors.length ? errors : null]);
        }).catch(e => {
            errors.push({file: null, e: new Error(`ERROR: unable to run glob expression ${globExpr}: ${e}`)});
            return resolve([null, errors]);
        });
    });
}

export function getDependencyErrors(map: ComponentManifestMap) {
    const errors: ManifestError[] = [];
    for (const fullname of Object.keys(map)) {
        const compo = map[fullname];
        if (!compo.depends_on) { continue; }
        for (const depname of compo.depends_on) {
            const depfullname = depname.indexOf('/') === -1 ? 
                                `${compo.project}/${depname}` : depname;
            const dep = map[depfullname];
            if (!dep) {
                errors.push({file: compo.manifest_path, e: new Error(
                    `ERROR: dependency '${depfullname}' not found\n    at ${compo.manifest_path}`)});
                continue;
            }
            compo._circular_dep_checker.push(dep);
        }
    }
    try {
        JSON.stringify(map);
        return errors.length ? errors : null;
    } catch (e) {
        errors.push({
            file: null,
            e: new Error(`ERROR: components manifest with a circular dependency`),
            data: map,
        });
        return errors;
    }
}

export function orderBuildsInGroups(mapArg: ComponentManifestMap) {
    const totalList: ComponentManifest[][] = [];
    const map = { ...mapArg }; // clone
    const alreadyBuilt: { [fullname: string]: ComponentManifest } = {};
    // extract root level dependencies
    let buildGroup = 0;
    for (const fullname of Object.keys(map)) {
        const compo = map[fullname];
        if (!compo.depends_on || compo.depends_on.length === 0) {
            if (!totalList[0]) { totalList.push([]); }
            totalList[0].push(compo);
            alreadyBuilt[fullname] = compo;
            delete map[fullname];
        }
    }
    while (Object.keys(map).length > 0) {
        totalList.push([]); buildGroup++;
        const toBeBuiltInThisGroup: string[] = [];
        for (const fullname of Object.keys(map)) {
            const compo = map[fullname];
            let allDepsReady = true;
            for (const dep of compo._circular_dep_checker) {
                if (!alreadyBuilt[dep.fullname]) { allDepsReady = false; break; }
            }
            if (!allDepsReady) { continue; }
            toBeBuiltInThisGroup.push(fullname);
        }
        for (const fullname of toBeBuiltInThisGroup) {
            const compo = map[fullname];
            totalList[buildGroup].push(compo);
            alreadyBuilt[fullname] = compo;
            delete map[fullname];
        }
        if (!toBeBuiltInThisGroup.length) {

        }
    }
    for (const fullname of Object.keys(alreadyBuilt)) {
        const compo = alreadyBuilt[fullname];
        if (compo._circular_dep_checker) { delete compo._circular_dep_checker; }
    }
    return totalList;
}
