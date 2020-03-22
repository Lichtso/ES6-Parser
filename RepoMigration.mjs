import child_process from 'child_process';
import process from 'process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import {performance} from 'perf_hooks';
import nodegit from 'nodegit';

import {Namespaces} from './Config.mjs';
import {performanceProfile, formatMemoryUsage, nonEmptyRmdirSync} from './Utils.mjs';
import {parseFile} from './Parser.mjs';
import {loaded, SymbolInternals, BasicBackend, JavaScriptBackend, RustWasmBackend, Diff, Repository} from 'SymatemJS';

if(process.argv.length != 3) {
    console.log('Expects one argument: Path of GIT repository');
    process.exit(-1);
}
const pwdPath = path.dirname(process.argv[1]),
      outDiffsPath = path.join(pwdPath, 'diffs');
nonEmptyRmdirSync(outDiffsPath);
fs.mkdirSync(outDiffsPath);

let inRepo, outRepo, backend, namespaces, emptyVersion,
    vertexCount = 0, orphanCount = 0, edgeCount = 0, forwardCounter = 0, backwardCounter = 0, forkCounter = 0;
const versions = {}, orphans = [],
      fileExtensionWhitelist = {'.js': true, '.mjs': true};

function identifierToSymbol(identifier) {
    const hash = crypto.createHash('md5');
    hash.update(identifier, 'utf8');
    return SymbolInternals.concatIntoSymbol(namespaces.Recording, parseInt(hash.digest('hex').substr(0, 8), 16));
}

function compareFile(backend, moduleIdentifier, moduleEntry, prefix='') {
    if(moduleEntry && Object.keys(moduleEntry.classes).length == 0)
        moduleEntry = undefined;
    else
        console.log(moduleIdentifier);

    let changesOccured = false;
    const moduleSymbol = identifierToSymbol(prefix+moduleIdentifier);
    for(const classSymbol of backend.getAndSetPairs(moduleSymbol, backend.symbolByName.Class)) {
        const classIdentifier = backend.getData(classSymbol),
              classEntry = (moduleEntry) ? moduleEntry.classes[classIdentifier] : undefined;
        for(const methodSymbol of backend.getAndSetPairs(classSymbol, backend.symbolByName.Method)) {
            const methodBodySymbol = backend.getPairOptionally(methodSymbol, backend.symbolByName.MethodBody),
                  methodIdentifier = backend.getData(methodSymbol),
                  methodEntry = (classEntry) ? classEntry.methods[methodIdentifier] : undefined;
            if(!methodEntry) {
                backend.setTriple([methodSymbol, backend.symbolByName.MethodBody, methodBodySymbol], false);
                if(!backend.getTriple([backend.symbolByName.Void, backend.symbolByName.Void, methodBodySymbol], BasicBackend.queryMasks.IIM)) {
                    backend.unlinkSymbol(methodBodySymbol);
                    console.log(`- MethodBody ${methodBodySymbol}`);
                }
                backend.setTriple([classSymbol, backend.symbolByName.Method, methodSymbol], false);
                if(!backend.getTriple([backend.symbolByName.Void, backend.symbolByName.Void, methodSymbol], BasicBackend.queryMasks.IIM))
                    backend.unlinkSymbol(methodSymbol);
                console.log(`- Method ${methodIdentifier} ${methodBodySymbol}`);
                changesOccured = true;
            }
        }
        if(!classEntry) {
            backend.setTriple([moduleSymbol, backend.symbolByName.Class, classSymbol], false);
            if(!backend.getTriple([backend.symbolByName.Void, backend.symbolByName.Void, classSymbol], BasicBackend.queryMasks.IIM))
                backend.unlinkSymbol(classSymbol);
            console.log(`- Class ${classIdentifier}`);
            changesOccured = true;
        }
    }
    const moduleExisted = backend.getTriple([backend.symbolByName.Root, backend.symbolByName.Module, moduleSymbol]);
    if(!moduleEntry) {
        if(moduleExisted) {
            backend.setTriple([backend.symbolByName.Root, backend.symbolByName.Module, moduleSymbol], false);
            if(!backend.getTriple([backend.symbolByName.Void, backend.symbolByName.Void, moduleSymbol], BasicBackend.queryMasks.IIM))
                backend.unlinkSymbol(moduleSymbol);
            console.log(`- Module ${moduleIdentifier}`);
            changesOccured = true;
        }
        return changesOccured;
    }
    if(!moduleExisted) {
        backend.manifestSymbol(moduleSymbol);
        backend.setTriple([backend.symbolByName.Root, backend.symbolByName.Module, moduleSymbol], true);
        if(backend.getLength(moduleSymbol) != moduleIdentifier.length*8)
            backend.setData(moduleSymbol, moduleIdentifier);
        console.log(`+ Module ${moduleIdentifier}`);
        changesOccured = true;
    }
    for(const classIdentifier in moduleEntry.classes) {
        const classEntry = moduleEntry.classes[classIdentifier],
              classSymbol = identifierToSymbol(prefix+classEntry.identifier);
        if(!backend.getTriple([moduleSymbol, backend.symbolByName.Class, classSymbol])) {
            backend.manifestSymbol(classSymbol);
            backend.setTriple([moduleSymbol, backend.symbolByName.Class, classSymbol], true);
            if(backend.getLength(classSymbol) != classIdentifier.length*8)
                backend.setData(classSymbol, classIdentifier);
            console.log(`+ Class ${classIdentifier}`);
            changesOccured = true;
        }
        for(const methodIdentifier in classEntry.methods) {
            const methodEntry = classEntry.methods[methodIdentifier],
                  methodSymbol = identifierToSymbol(prefix+methodEntry.globalIdentifier),
                  methodBodySymbol = identifierToSymbol(prefix+methodEntry.body),
                  prevMethodBodySymbol = backend.getPairOptionally(methodSymbol, backend.symbolByName.MethodBody);
            if(!backend.getTriple([classSymbol, backend.symbolByName.Method, methodSymbol])) {
                backend.manifestSymbol(methodSymbol);
                backend.setTriple([classSymbol, backend.symbolByName.Method, methodSymbol], true);
                if(backend.getLength(methodSymbol) != methodEntry.globalIdentifier.length*8)
                    backend.setData(methodSymbol, methodEntry.globalIdentifier);
                console.log(`+ Method ${methodIdentifier} ${methodBodySymbol}`);
                changesOccured = true;
            }
            if(methodBodySymbol != prevMethodBodySymbol) {
                backend.manifestSymbol(methodBodySymbol);
                backend.setTriple([methodSymbol, backend.symbolByName.MethodBody, methodBodySymbol], true);
                if(backend.getLength(methodBodySymbol) != methodEntry.body.length*8) {
                    backend.setData(methodBodySymbol, methodEntry.body);
                    console.log(`+ MethodBody ${methodBodySymbol}`);
                }
                changesOccured = true;
                if(prevMethodBodySymbol != backend.symbolByName.Void) {
                    backend.setTriple([methodSymbol, backend.symbolByName.MethodBody, prevMethodBodySymbol], false);
                    if(!backend.getTriple([backend.symbolByName.Void, backend.symbolByName.Void, prevMethodBodySymbol], BasicBackend.queryMasks.IIM)) {
                        backend.unlinkSymbol(prevMethodBodySymbol);
                        console.log(`- MethodBody ${methodBodySymbol}`);
                    }
                    console.log(`* MethodBody ${methodIdentifier} ${prevMethodBodySymbol} => ${methodBodySymbol}`);
                }
            }
        }
    }
    return changesOccured;
}

function processGitDiff(parentVersion, childVersion) {
    ++forwardCounter; console.log(`${parentVersion.hash} --> ${childVersion.hash}`);
    let childTree, changesOccured = false;
    const outDiff = new Diff(backend, outRepo.namespace, outRepo.relocationTable);
    return Promise.all([
        (parentVersion == emptyVersion) ? nodegit.Tree.lookup(inRepo, parentVersion.hash) : nodegit.Commit.lookup(inRepo, parentVersion.hash).then((commit) => commit.getTree()),
        nodegit.Commit.lookup(inRepo, childVersion.hash).then((commit) => commit.getTree())
    ]).then((trees) => {
        childTree = trees[1];
        performance.mark('git diff');
        return nodegit.Diff.treeToTree(inRepo, trees[0], trees[1]);
    }).then((diff) => {
        const promisePool = [];
        for(let i = 0; i < diff.numDeltas(); ++i) {
            const delta = diff.getDelta(i);
            console.assert(delta.status() == nodegit.Diff.DELTA.ADDED || delta.status() == nodegit.Diff.DELTA.MODIFIED || delta.status() == nodegit.Diff.DELTA.DELETED || delta.status() == nodegit.Diff.DELTA.RENAMED);
            let filePath = delta.oldFile().path();
            if(fileExtensionWhitelist[path.extname(filePath)] && (delta.status() == nodegit.Diff.DELTA.DELETED || delta.status() == nodegit.Diff.DELTA.RENAMED))
                promisePool.push(new Promise((resolve, reject) => resolve([filePath, undefined])));
            filePath = delta.newFile().path();
            if(fileExtensionWhitelist[path.extname(filePath)] && (delta.status() == nodegit.Diff.DELTA.ADDED || delta.status() == nodegit.Diff.DELTA.MODIFIED || delta.status() == nodegit.Diff.DELTA.RENAMED))
                promisePool.push(childTree.entryByPath(filePath)
                .then((treeEntry) => inRepo.getBlob(treeEntry.id()))
                .then((blob) => blob.content().toString())
                .then((fileContent) => [filePath, fileContent]));
        }
        performance.mark('git checkout');
        performance.measure('git diff', 'git diff', 'git checkout');
        return Promise.all(promisePool);
    }).then((parsedFiles) => {
        performance.mark('parse');
        performance.measure('git checkout', 'git checkout', 'parse');
        for(const entry of parsedFiles)
            if(entry[1])
                entry[1] = parseFile(entry[0], entry[1]);
        performance.mark('record');
        performance.measure('parse', 'parse', 'record');
        for(const [filePath, moduleEntry] of parsedFiles)
            if(compareFile(outDiff, filePath, moduleEntry))
                changesOccured = true;
        performance.mark('commit');
        performance.measure('record', 'record', 'commit');
        outDiff.compressData();
        outDiff.commit();
        performance.mark('write to disk');
        performance.measure('commit', 'commit', 'write to disk');
        const fileContent = outDiff.encodeJson();
        console.assert(changesOccured == (fileContent != '{}'));
        if(changesOccured) {
            const edge = outRepo.getEdge(parentVersion.symbol, childVersion.symbol);
            if(childVersion.parentCount == 1) {
                outDiff.link();
                backend.setTriple([edge, backend.symbolByName.Diff, outDiff.symbol], true);
            } else {
                fs.writeFileSync(path.join(outDiffsPath, `${parentVersion.hash}-${childVersion.hash}.json`), fileContent);
                backend.setTriple([edge, backend.symbolByName.Diff, backend.symbolByName.Diff], true);
            }
        }
        performance.mark('unlink');
        performance.measure('write to disk', 'write to disk', 'unlink');
        if(!outDiff.symbol)
            outDiff.unlink();
        return changesOccured;
    }).catch(err => console.error(err));
}

function trackUntilMerge(stack, lastPromise) {
    let version = stack[stack.length-1];
    while(version.childrenLeft.length > 0) {
        if(version.parentsLeft > 0)
            break;
        if(version.childrenLeft.length > 1)
            ++forkCounter;
        const nextVersion = getVersion(backend.getData(version.childrenLeft.shift())),
              parentVersion = version;
        --nextVersion.parentsLeft;
        lastPromise = lastPromise.then(() => processGitDiff(parentVersion, nextVersion));
        version = nextVersion;
        stack.push(nextVersion);
    }
    return lastPromise;
}

function revert(parentVersion, childVersion) {
    ++backwardCounter; console.log(`${parentVersion.hash} <-- ${childVersion.hash}`);
    const edge = outRepo.getEdge(parentVersion.symbol, childVersion.symbol),
          diffSymbol = backend.getPairOptionally(edge, backend.symbolByName.Diff);
    if(diffSymbol != backend.symbolByName.Void) {
        performance.mark('load diffs');
        const diff = new Diff(backend, outRepo.namespace, outRepo.relocationTable, (diffSymbol != backend.symbolByName.Diff) ? diffSymbol : undefined);
        if(!diff.symbol)
            diff.decodeJson(fs.readFileSync(path.join(outDiffsPath, `${parentVersion.hash}-${childVersion.hash}.json`), 'utf8'));
        performance.mark('revert');
        performance.measure('load diffs', 'load diffs', 'revert');
        diff.apply(true, {[namespaces.Modal]: namespaces.Recording});
        performance.mark('unlink');
        performance.measure('revert', 'revert', 'unlink');
        if(!diff.symbol)
            diff.unlink();
    }
}

function backtrackUntilFork(stack, lastPromise) {
    let version = stack.pop();
    for(let i = stack.length-1; i >= 0; --i) {
        const nextVersion = stack.pop(),
              childVersion = version;
        lastPromise = lastPromise.then(() => revert(nextVersion, childVersion));
        if(nextVersion.childrenLeft.length > 0) {
            --forkCounter;
            stack.push(nextVersion);
            break;
        }
        version = nextVersion;
    }
    return lastPromise;
}

function walkVersionDAG() {
    const startTime = process.hrtime()[0];
    let lastPromise = new Promise((resolve, reject) => resolve());
    while(orphans.length > 0) {
        const stack = [orphans.shift()];
        lastPromise = lastPromise.then(() => {
            // global.gc();
            console.log(`Reset at ${stack[0].hash}`);
            backend.clearNamespace(namespaces.Recording);
        });
        lastPromise = lastPromise.then(() => processGitDiff(emptyVersion, stack[0]));
        while(stack.length > 0) {
            lastPromise = lastPromise.then(() => {
                const progress = forwardCounter/edgeCount,
                      timeSpent = process.hrtime()[0]-startTime,
                      remainingSeconds = (1.0-progress)*timeSpent/progress,
                      messages = [
                          `Remaining: ${Math.round(remainingSeconds)}s`,
                          `Edges: ${forwardCounter}/${edgeCount} (${(progress*100).toFixed(2)}%)`,
                          `JS-heap: ${formatMemoryUsage(process.memoryUsage().heapUsed, 4294967296)}`
                      ];
                if(backend instanceof RustWasmBackend)
                    messages.push(`WASM: ${formatMemoryUsage(backend.getMemoryUsage(), 2147483648)}`);
                console.log(messages.join(', '));
            });
            lastPromise = trackUntilMerge(stack, lastPromise);
            if(forkCounter == 0)
                break;
            lastPromise = backtrackUntilFork(stack, lastPromise);
        }
    }
    return lastPromise.then(() => {
        fs.writeFileSync(path.join(outDiffsPath, 'repository.json'), backend.encodeJson([outRepo.namespace]), 'utf8');
        console.log(`vertexCount=${vertexCount}, orphanCount=${orphanCount}, edgeCount=${edgeCount}, forwardCounter=${forwardCounter}, backwardCounter=${backwardCounter}, ratio=${backwardCounter/forwardCounter}`);
        console.log(performanceProfile);
    });
}

function getVersion(versionHash) {
    let version = versions[versionHash];
    if(version)
        return version;
    version = versions[versionHash] = {'hash': versionHash, 'symbol': outRepo.createVersion()};
    backend.setData(version.symbol, versionHash);
    return version;
}

loaded.then(() => {
    backend = (true) ? new RustWasmBackend() : new JavaScriptBackend();
    backend.initPredefinedSymbols();
    namespaces = backend.registerNamespaces(Namespaces);
    outRepo = new Repository(backend, namespaces.Repository, {[namespaces.Recording]: namespaces.Modal});
    emptyVersion = getVersion('4b825dc642cb6eb9a060e54bf8d69288fbee4904');

    nodegit.Repository.open(process.argv[2])
    .then((repo) => {
        inRepo = repo;
        return repo.getHeadCommit();
    })
    .then((commit) => {
        const history = commit.history();
        history.on('commit', (commit) => {
            const version = getVersion(commit.sha());
            commit.getParents().then((parents) => {
                for(const parent of parents)
                    outRepo.addEdge(getVersion(parent.sha()).symbol, version.symbol);
                if(parents.length == 0) {
                    outRepo.addEdge(emptyVersion.symbol, version.symbol);
                    orphans.push(version);
                }
            });
        });
        history.on('end', function(commits) {
            vertexCount = commits.length;
            orphanCount = orphans.length;
            for(const versionSymbol of outRepo.getVersions()) {
                const version = versions[backend.getData(versionSymbol)];
                version.parentCount = Object.keys(outRepo.getRelatives(versionSymbol, backend.symbolByName.Parent)).length;
                version.parentsLeft = version.parentCount;
                version.childrenLeft = Object.keys(outRepo.getRelatives(versionSymbol, backend.symbolByName.Child));
                edgeCount += version.childrenLeft.length;
            }
            for(const version of orphans)
                version.parentsLeft = 0;
            walkVersionDAG();
        });
        history.start();
    });
});
