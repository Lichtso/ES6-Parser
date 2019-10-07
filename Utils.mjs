import path from 'path';
import fs from 'fs';
import {performance, PerformanceObserver} from 'perf_hooks';
import assert from 'assert';
console.assert = assert;

export const performanceProfile = {};
const performanceObserver = new PerformanceObserver((list) => {
    for(const entry of list.getEntries()) {
        if(performanceProfile[entry.name])
            performanceProfile[entry.name] += entry.duration*0.001;
        else
            performanceProfile[entry.name] = entry.duration*0.001;
    }
});
performanceObserver.observe({'entryTypes': ['function']});

export function formatMemoryUsage(usage, maximum) {
    const percentage = usage/maximum*100;
    let unit = 'B';
    for(const [factor, name] of [[1024*1024*1024, 'GiB'], [1024*1024, 'MiB'], [1024, 'KiB']]) {
        if(usage > factor) {
            usage /= factor;
            unit = name;
            break;
        }
    }
    return `${usage.toFixed(2)} ${unit} (${percentage.toFixed(2)}%)`;
}

export function nonEmptyRmdirSync(path) {
    if(path == '/' || !fs.existsSync(path))
        return;
    for(const file of fs.readdirSync(path)) {
        const currentPath = `${path}/${file}`;
        if(fs.lstatSync(currentPath).isDirectory())
            nonEmptyRmdirSync(currentPath);
        else
            fs.unlinkSync(currentPath);
    }
    fs.rmdirSync(path);
}

export function insertIntoMapOfSets(setMap, key, value) {
    if(setMap.has(key))
        setMap.get(key).add(value);
    else
        setMap.set(key, new Set([value]));
}
