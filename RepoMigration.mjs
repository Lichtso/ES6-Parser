import child_process from 'child_process';
import process from 'process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import {performance} from 'perf_hooks';
import nodegit from 'nodegit';

import {parserSymbols, repositoryNamespace, recordingNamespace, modalNamespace} from './Config.mjs';
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

let inRepo, outRepo, backend, parserNamespace,
    vertexCount = 0, orphanCount = 0, edgeCount = 0, forwardCounter = 0, backwardCounter = 0, forkCounter = 0;
const emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function identifierToSymbol(identifier) {
    const hash = crypto.createHash('md5');
    hash.update(identifier, 'utf8');
    return SymbolInternals.concatIntoSymbol(recordingNamespace, parseInt(hash.digest('hex').substr(0, 8), 16));
}

function compareFile(backend, moduleIdentifier, moduleEntry, prefix='') {
    if(moduleEntry && Object.keys(moduleEntry.classes).length == 0)
        moduleEntry = undefined;
    else
        console.log(moduleIdentifier);

    let changesOccured = false;
    const moduleSymbol = identifierToSymbol(prefix+moduleIdentifier);
    for(const classSymbol of backend.getAndSetPairs(moduleSymbol, BasicBackend.symbolByName.Class)) {
        const classIdentifier = backend.getData(classSymbol),
              classEntry = (moduleEntry) ? moduleEntry.classes[classIdentifier] : undefined;
        for(const methodSymbol of backend.getAndSetPairs(classSymbol, BasicBackend.symbolByName.Method)) {
            const methodBodySymbol = backend.getPairOptionally(methodSymbol, BasicBackend.symbolByName.MethodBody),
                  methodIdentifier = backend.getData(methodSymbol),
                  methodEntry = (classEntry) ? classEntry.methods[methodIdentifier] : undefined;
            if(!methodEntry) {
                backend.setTriple([methodSymbol, BasicBackend.symbolByName.MethodBody, methodBodySymbol], false);
                if(!backend.getTriple([BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void, methodBodySymbol], BasicBackend.queryMasks.IIM))
                    backend.unlinkSymbol(methodBodySymbol);
                backend.setTriple([classSymbol, BasicBackend.symbolByName.Method, methodSymbol], false);
                if(!backend.getTriple([BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void, methodSymbol], BasicBackend.queryMasks.IIM))
                    backend.unlinkSymbol(methodSymbol);
                console.log(`- Method ${methodIdentifier} ${methodBodySymbol}`);
                changesOccured = true;
            }
        }
        if(!classEntry) {
            backend.setTriple([moduleSymbol, BasicBackend.symbolByName.Class, classSymbol], false);
            if(!backend.getTriple([BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void, classSymbol], BasicBackend.queryMasks.IIM))
                backend.unlinkSymbol(classSymbol);
            console.log(`- Class ${classIdentifier}`);
            changesOccured = true;
        }
    }
    const moduleExisted = backend.getTriple([BasicBackend.symbolByName.Root, BasicBackend.symbolByName.Module, moduleSymbol]);
    if(!moduleEntry) {
        if(moduleExisted) {
            backend.setTriple([BasicBackend.symbolByName.Root, BasicBackend.symbolByName.Module, moduleSymbol], false);
            if(!backend.getTriple([BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void, moduleSymbol], BasicBackend.queryMasks.IIM))
                backend.unlinkSymbol(moduleSymbol);
            console.log(`- Module ${moduleIdentifier}`);
            changesOccured = true;
        }
        return changesOccured;
    }
    if(!moduleExisted) {
        backend.manifestSymbol(moduleSymbol);
        backend.setTriple([BasicBackend.symbolByName.Root, BasicBackend.symbolByName.Module, moduleSymbol], true);
        if(backend.getLength(moduleSymbol) != moduleIdentifier.length*8)
            backend.setData(moduleSymbol, moduleIdentifier);
        console.log(`+ Module ${moduleIdentifier}`);
        changesOccured = true;
    }
    for(const classIdentifier in moduleEntry.classes) {
        const classEntry = moduleEntry.classes[classIdentifier],
              classSymbol = identifierToSymbol(prefix+classEntry.identifier);
        if(!backend.getTriple([moduleSymbol, BasicBackend.symbolByName.Class, classSymbol])) {
            backend.manifestSymbol(classSymbol);
            backend.setTriple([moduleSymbol, BasicBackend.symbolByName.Class, classSymbol], true);
            if(backend.getLength(classSymbol) != classIdentifier.length*8)
                backend.setData(classSymbol, classIdentifier);
            console.log(`+ Class ${classIdentifier}`);
            changesOccured = true;
        }
        for(const methodIdentifier in classEntry.methods) {
            const methodEntry = classEntry.methods[methodIdentifier],
                  methodSymbol = identifierToSymbol(prefix+methodEntry.globalIdentifier),
                  methodBodySymbol = identifierToSymbol(prefix+methodEntry.body),
                  prevMethodBodySymbol = backend.getPairOptionally(methodSymbol, BasicBackend.symbolByName.MethodBody);
            if(!backend.getTriple([classSymbol, BasicBackend.symbolByName.Method, methodSymbol])) {
                backend.manifestSymbol(methodSymbol);
                backend.setTriple([classSymbol, BasicBackend.symbolByName.Method, methodSymbol], true);
                if(backend.getLength(methodSymbol) != methodEntry.globalIdentifier.length*8)
                    backend.setData(methodSymbol, methodEntry.globalIdentifier);
                console.log(`+ Method ${methodIdentifier} ${methodBodySymbol}`);
                changesOccured = true;
            }
            if(methodBodySymbol != prevMethodBodySymbol) {
                backend.manifestSymbol(methodBodySymbol);
                backend.setTriple([methodSymbol, BasicBackend.symbolByName.MethodBody, methodBodySymbol], true);
                if(backend.getLength(methodBodySymbol) != methodEntry.body.length*8)
                    backend.setData(methodBodySymbol, methodEntry.body);
                changesOccured = true;
                if(prevMethodBodySymbol != BasicBackend.symbolByName.Void) {
                    backend.setTriple([methodSymbol, BasicBackend.symbolByName.MethodBody, prevMethodBodySymbol], false);
                    if(!backend.getTriple([BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void, prevMethodBodySymbol], BasicBackend.queryMasks.IIM))
                        backend.unlinkSymbol(prevMethodBodySymbol);
                    console.log(`* Method ${methodIdentifier} ${methodBodySymbol}`);
                }
            }
        }
    }
    return changesOccured;
}

function processGitDiff(parentVersionId, childVersionId) {
    ++forwardCounter; console.log(`${parentVersionId} --> ${childVersionId}`);
    let childTree, changesOccured = false;
    const outDiff = new Diff(backend, {[recordingNamespace]: modalNamespace}, repositoryNamespace);
    return Promise.all([
        nodegit.Commit.lookup(inRepo, parentVersionId).then((commit) => commit.getTree()),
        nodegit.Commit.lookup(inRepo, childVersionId).then((commit) => commit.getTree())
    ]).then((trees) => {
        childTree = trees[1];
        performance.mark('git diff');
        return nodegit.Diff.treeToTree(inRepo, trees[0], trees[1]);
    }).then((diff) => {
        const promisePool = [];
        for(let i = 0; i < diff.numDeltas(); ++i) {
            const delta = diff.getDelta(i);
            // console.log('Delta', delta.newFile().path(), delta.oldFile().path(), delta.status());
            console.assert(delta.status() == nodegit.Diff.DELTA.ADDED || delta.status() == nodegit.Diff.DELTA.MODIFIED || delta.status() == nodegit.Diff.DELTA.DELETED || delta.status() == nodegit.Diff.DELTA.RENAMED);
            let filePath = delta.oldFile().path();
            if(path.extname(filePath) == '.js' && (delta.status() == nodegit.Diff.DELTA.DELETED || delta.status() == nodegit.Diff.DELTA.RENAMED))
                promisePool.push(new Promise((resolve, reject) => resolve([filePath, undefined])));
            filePath = delta.newFile().path();
            if(path.extname(filePath) == '.js' && (delta.status() == nodegit.Diff.DELTA.ADDED || delta.status() == nodegit.Diff.DELTA.MODIFIED || delta.status() == nodegit.Diff.DELTA.RENAMED))
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
        if(fileContent != '{}') {
            const outDiffName = `${parentVersionId}-${childVersionId}.json`;
            outRepo.addDiff(parentVersionId, childVersionId, outDiffName);
            fs.writeFileSync(path.join(outDiffsPath, outDiffName), fileContent);
        }
        performance.mark('unlink');
        performance.measure('write to disk', 'write to disk', 'unlink');
        outDiff.unlink();
        return changesOccured;
    }).catch(err => console.error(err));
}

function findLooseEnd(versionsIn) {
    for(const versionId in versionsIn)
        if(versionsIn[versionId].parentsLeft == 0 && versionsIn[versionId].childrenLeft.length > 0)
            return versionId;
}

function trackUntilMerge(versionsIn, stack, lastPromise) {
    let versionId = stack[stack.length-1];
    while(versionsIn[versionId].childrenLeft.length > 0) {
        if(versionsIn[versionId].parentsLeft > 0)
            break;
        if(versionsIn[versionId].childrenLeft.length > 1)
            ++forkCounter;
        const nextVersionId = versionsIn[versionId].childrenLeft.shift(),
              parentVersionId = versionId;
        --versionsIn[nextVersionId].parentsLeft;
        lastPromise = lastPromise.then(() => processGitDiff(parentVersionId, nextVersionId));
        versionId = nextVersionId;
        stack.push(nextVersionId);
    }
    return lastPromise;
}

function revert(parentVersionId, childVersionId) {
    ++backwardCounter; console.log(`${parentVersionId} <-- ${childVersionId}`);
    const differentialName = outRepo.versions[parentVersionId].children[childVersionId];
    if(differentialName) {
        const differential = new Diff(backend, {[recordingNamespace]: modalNamespace}, repositoryNamespace);
        performance.mark('read from disk');
        differential.decodeJson(fs.readFileSync(path.join(outDiffsPath, differentialName), 'utf8'));
        performance.mark('revert');
        performance.measure('read from disk', 'read from disk', 'revert');
        differential.apply(true, {[modalNamespace]: recordingNamespace});
        performance.mark('unlink');
        performance.measure('revert', 'revert', 'unlink');
        differential.unlink();
    }
}

function backtrackUntilFork(versionsIn, stack, lastPromise) {
    let versionId = stack.pop();
    for(let i = stack.length-1; i >= 0; --i) {
        const nextVersionId = stack.pop(),
              childVersionId = versionId;
        lastPromise = lastPromise.then(() => revert(nextVersionId, childVersionId));
        if(versionsIn[nextVersionId].childrenLeft.length > 0) {
            --forkCounter;
            stack.push(nextVersionId);
            break;
        }
        versionId = nextVersionId;
    }
    return lastPromise;
}

function walkVersionDAG(versionsIn) {
    const startTime = process.hrtime()[0];
    let lastPromise = new Promise((resolve, reject) => resolve());
    while(true) {
        const stack = [findLooseEnd(versionsIn)];
        if(!stack[0])
            break;
        lastPromise = lastPromise.then(() => {
            // global.gc();
            console.log(`Reset at ${stack[0]}`); ++orphanCount;
            backend.unlinkSymbol(BasicBackend.symbolInNamespace('Namespaces', recordingNamespace));
        });
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
            lastPromise = trackUntilMerge(versionsIn, stack, lastPromise);
            if(forkCounter == 0)
                break;
            lastPromise = backtrackUntilFork(versionsIn, stack, lastPromise);
        }
    }
    return lastPromise.then(() => {
        fs.writeFileSync(path.join(outDiffsPath, 'versionDAG.json'), JSON.stringify(outRepo.versions, undefined, '\t'));
        console.log(`vertexCount=${vertexCount}, orphanCount=${orphanCount}, edgeCount=${edgeCount}, forwardCounter=${forwardCounter}, backwardCounter=${backwardCounter}, ratio=${backwardCounter/forwardCounter}`);
        console.log(performanceProfile);
    });
}

loaded.then(() => {
    backend = (true) ? new RustWasmBackend() : new JavaScriptBackend();
    backend.initPredefinedSymbols();
    outRepo = new Repository(backend, repositoryNamespace);
    parserNamespace = backend.registerAdditionalSymbols('ES6 Parser', parserSymbols);

    nodegit.Repository.open(process.argv[2])
    .then((repo) => {
        inRepo = repo;
        return repo.getHeadCommit();
    })
    .then((commit) => {
        const history = commit.history();
        history.on('commit', (commit) => {
            commit.getParents().then((parents) => {
                for(const parent of parents)
                    outRepo.addDiff(parent.sha(), commit.sha(), false);
            });
        });
        history.on('end', function(commits) {
            vertexCount = commits.length;
            const versionsIn = {};
            for(const versionId in outRepo.versions) {
                versionsIn[versionId] = {
                    parents: Object.keys(outRepo.versions[versionId].parents),
                    children: Object.keys(outRepo.versions[versionId].children)
                };
                versionsIn[versionId].parentsLeft = versionsIn[versionId].parents.length;
                versionsIn[versionId].childrenLeft = Array.from(versionsIn[versionId].children);
                edgeCount += versionsIn[versionId].childrenLeft.length;
            }
            walkVersionDAG(versionsIn);
        });
        history.start();
    });
});
