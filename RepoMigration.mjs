import child_process from 'child_process';
import process from 'process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import {performance} from 'perf_hooks';
// import heapdump from 'heapdump';
// import Git from 'isomorphic-git';

import {parserSymbols, repositoryNamespace, recordingNamespace, modalNamespace} from './Config.mjs';
import {performanceProfile, formatMemoryUsage, nonEmptyRmdirSync} from './Utils.mjs';
import {parseFile} from './Parser.mjs';
const parseFileTimed = performance.timerify(parseFile);
import {loaded, SymbolInternals, BasicBackend, JavaScriptBackend, RustWasmBackend, Differential, Repository} from './node_modules/SymatemJS/dist/SymatemJS.mjs';

if(process.argv.length != 4) {
    console.log('Expects two command line arguments: Path of GIT repository, branch name');
    process.exit(-1);
}

loaded.then(() => {
    const backend = new JavaScriptBackend();
    backend.initPredefinedSymbols();
    const parserNamespace = backend.registerAdditionalSymbols('ES6 Parser', parserSymbols),
          repository = new Repository(backend, repositoryNamespace),
          emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    function identifierToSymbol(identifier) {
        const hash = crypto.createHash('md5');
        hash.update(identifier, 'utf8');
        return SymbolInternals.concatIntoSymbol(recordingNamespace, parseInt(hash.digest('hex').substr(0, 8), 16));
    }

    function gitCheckout(versionId) {
        child_process.execSync(`git checkout -q ${versionId}`);
    }
    const gitCheckoutTimed = performance.timerify(gitCheckout);

    function compareFile(backend, moduleIdentifier, moduleEntry, prefix='') {
        if(moduleEntry && Object.keys(moduleEntry.classes).length == 0)
            moduleEntry = undefined;
        let changesOccured = false;
        const moduleSymbol = identifierToSymbol(prefix+moduleIdentifier);
        console.log(moduleIdentifier);
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
                    backend.setTriple([classSymbol, BasicBackend.symbolByName.Method, methodSymbol], true);
                    if(backend.getLength(methodSymbol) != methodEntry.globalIdentifier.length*8)
                        backend.setData(methodSymbol, methodEntry.globalIdentifier);
                    console.log(`+ Method ${methodIdentifier} ${methodBodySymbol}`);
                    changesOccured = true;
                }
                if(methodBodySymbol != prevMethodBodySymbol) {
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
    const compareFileTimed = performance.timerify(compareFile);

    const pwdPath = path.dirname(process.argv[1]),
          differentialsPath = path.join(pwdPath, 'differentials');
    nonEmptyRmdirSync(differentialsPath);
    fs.mkdirSync(differentialsPath);
    process.chdir(process.argv[2]);
    const revList = child_process.execSync(`git rev-list --parents ${process.argv[3]}`).toString().split('\n').slice(0, -1).map(line => line.split(' ')),
          versionsIn = {};
    for(const revListEntry of revList) {
        const versionId = revListEntry[0],
              parents = revListEntry.slice(1);
        versionsIn[versionId] = {
            'parents': parents,
            'parentsLeft': parents.length,
            'children': []
        };
    }
    for(const childVersionId in versionsIn)
        for(const parentVersionId of versionsIn[childVersionId].parents)
            versionsIn[parentVersionId].children.push(childVersionId);
    let vertexCount = revList.length, orphanCount = 0, edgeCount = 0, forwardCounter = 0, backwardCounter = 0, forkCounter = 0;
    for(const versionId in versionsIn) {
        const childrenLeft = Array.from(versionsIn[versionId].children);
        versionsIn[versionId].childrenLeft = childrenLeft;
        edgeCount += childrenLeft.length;
    }

    function processGitDiff(parentVersionId, childVersionId) {
        let changesOccured = false;
        const differential = new Differential(backend, {[recordingNamespace]: modalNamespace}, repositoryNamespace);
        const files = child_process.execSync(`git diff --no-renames --numstat ${parentVersionId} ${childVersionId}`).toString().split('\n').slice(0, -1).map(line => line.split('\t')[2]);
        gitCheckoutTimed(childVersionId);
        for(const filePath of files) {
            if(filePath.substr(0, 3) == '...' || filePath.substr(filePath.length-3) != '.js')
                continue;
            if(compareFileTimed(differential, filePath, parseFileTimed(filePath)))
                changesOccured = true;
        }
        differential.compressData();
        differential.commit();
        const fileContent = differential.encodeJson();
        console.assert(changesOccured == (fileContent != '{}'));
        if(fileContent != '{}') {
            const differentialPath = `${parentVersionId}-${childVersionId}.json`;
            repository.addDifferential(parentVersionId, childVersionId, differentialPath);
            fs.writeFileSync(path.join(differentialsPath, differentialPath), fileContent);
        }
        differential.unlink();
        return changesOccured;
    }

    function findLooseEnd() {
        for(const versionId in versionsIn)
            if(versionsIn[versionId].parentsLeft == 0 && versionsIn[versionId].childrenLeft.length > 0)
                return versionId;
    }

    function trackUntilMerge(path) {
        let versionId = path[path.length-1];
        while(versionsIn[versionId].childrenLeft.length > 0) {
            if(versionsIn[versionId].parentsLeft > 0)
                return;
            if(versionsIn[versionId].childrenLeft.length > 1)
                ++forkCounter;
            const nextVersionId = versionsIn[versionId].childrenLeft.shift();
            --versionsIn[nextVersionId].parentsLeft;
            ++forwardCounter; console.log(`${versionId} --> ${nextVersionId}`);
            processGitDiff(versionId, nextVersionId);
            versionId = nextVersionId;
            path.push(nextVersionId);
        }
    }

    function backtrackUntilFork(path) {
        let versionId = path.pop();
        for(let i = path.length-1; i >= 0; --i) {
            const nextVersionId = path.pop();
            ++backwardCounter; console.log(`${nextVersionId} <-- ${versionId}`);
            const differentialPath = path.join(differentialsPath, `${nextVersionId}-${versionId}.json`);
            if(fs.existsSync(differentialPath)) {
                const differential = new Differential(backend, {[recordingNamespace]: modalNamespace}, repositoryNamespace);
                differential.decodeJson(fs.readFileSync(differentialPath, 'utf8'));
                differential.apply(true, {[modalNamespace]: recordingNamespace});
                differential.unlink();
            }
            if(versionsIn[nextVersionId].childrenLeft.length > 0) {
                --forkCounter;
                path.push(nextVersionId);
                return;
            }
            versionId = nextVersionId;
        }
    }
    const backtrackUntilForkTimed = performance.timerify(backtrackUntilFork);

    const startTime = process.hrtime()[0];
    while(true) {
        const path = [findLooseEnd()];
        if(!path[0])
            break;
        console.log(`Reset at ${path[0]}`); ++orphanCount;
        backend.unlinkSymbol(BasicBackend.symbolInNamespace('Namespaces', recordingNamespace));
        // global.gc();
        while(path.length > 0) {
            const progress = forwardCounter/edgeCount,
                  timeSpent = process.hrtime()[0]-startTime,
                  remainingSeconds = (1.0-progress)*timeSpent/progress;
            console.log(`Edges: ${forwardCounter}/${edgeCount} (${(progress*100).toFixed(2)}%), JS-heap: ${formatMemoryUsage(process.memoryUsage().heapUsed, 4294967296)}, remaining: ${Math.round(remainingSeconds)}s`);
            gitCheckoutTimed(path[path.length-1]);
            trackUntilMerge(path);
            if(forkCounter == 0)
                break;
            backtrackUntilForkTimed(path);
        }
    }

    fs.writeFileSync(path.join(differentialsPath, 'versionDAG.json'), JSON.stringify(repository.versions, undefined, '\t'));
    console.log(`vertexCount=${vertexCount}, orphanCount=${orphanCount}, edgeCount=${edgeCount}, forwardCounter=${forwardCounter}, backwardCounter=${backwardCounter}, ratio=${backwardCounter/forwardCounter}`);
    console.log(performanceProfile);
    // heapdump.writeSnapshot(`../out/heapsnapshot-${Date.now()}.json2`);
});
