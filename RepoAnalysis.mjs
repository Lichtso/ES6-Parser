import process from 'process';
import path from 'path';
import fs from 'fs';
import {performance} from 'perf_hooks';

import {parserSymbols, repositoryNamespace, recordingNamespace, modalNamespace} from './Config.mjs';
import {performanceProfile, formatMemoryUsage, insertIntoMapOfSets} from './Utils.mjs';
import {loaded, BasicBackend, JavaScriptBackend, RustWasmBackend, Diff, Repository} from 'SymatemJS';

loaded.then(() => {
    const backend = new RustWasmBackend();
    backend.initPredefinedSymbols();
    const parserNamespace = backend.registerAdditionalSymbols('ES6 Parser', parserSymbols),
          repository = new Repository(backend, repositoryNamespace);

    function analyzeTripleOperations(operations) {
        const accumulator = {'Module': 0, 'Class': 0, 'Method': 0, 'MethodBody': 0};
        if(operations)
            for(const operation of operations)
                for(const type in accumulator)
                    if(operation.triple[1] == BasicBackend.symbolByName[type])
                        ++accumulator[type];
        return accumulator;
    }

    const pwdPath = path.dirname(process.argv[1]),
          diffsPath = path.join(pwdPath, 'diffs');
    repository.versions = JSON.parse(fs.readFileSync(path.join(diffsPath, 'versionDAG.json'), 'utf8'));

    function loadDiffs() {
        for(const versionId in repository.versions) {
            const edges = repository.versions[versionId].parents,
                  parents = Object.keys(edges);
            if(parents.length == 1 && edges[parents[0]]) {
                const name = edges[parents[0]],
                      diff = new Diff(backend, {[recordingNamespace]: modalNamespace}, repositoryNamespace);
                diff.decodeJson(fs.readFileSync(path.join(diffsPath, name), 'utf8'));
                diff.link(repositoryNamespace);
                backend.setData(diff.symbol, name);
                console.log(name,
                    analyzeTripleOperations(diff.postCommitStructure.linkTripleOperations),
                    analyzeTripleOperations(diff.postCommitStructure.unlinkTripleOperations)
                );
            }
        }
    }
    performance.timerify(loadDiffs)();
    console.log(`JS-heap: ${formatMemoryUsage(process.memoryUsage().heapUsed, 4294967296)}, WASM: ${formatMemoryUsage(backend.getMemoryUsage(), 4294967296)}`);

    let repoSymbolCount = 0, modalSymbolCount = 0, tripleCount = 0;
    for(const symbol of backend.querySymbols(repositoryNamespace))
        ++repoSymbolCount;
    for(const symbol of backend.querySymbols(modalNamespace))
        ++modalSymbolCount;
    for(const triple of backend.queryTriples(BasicBackend.queryMasks.VVV, [BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Void]))
        ++tripleCount;
    console.log(`${repoSymbolCount} Repository Symbols, ${modalSymbolCount} Modal Symbols, ${tripleCount} Triples`);

    function getNameOfSymbolFromDiff(symbol) {
        for(const triple of backend.queryTriples(BasicBackend.queryMasks.VMM, [BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Destination, symbol])) {
            const replaceDataOperation = triple[0],
                  differentalSymbol = backend.getPairOptionally(BasicBackend.symbolByName.ReplaceData, replaceDataOperation, BasicBackend.queryMasks.VMM);
            if(differentalSymbol == BasicBackend.symbolByName.Void)
                continue;
            const dataSource = backend.getPairOptionally(differentalSymbol, BasicBackend.symbolByName.DataSource),
                  sourceOffset = backend.getData(backend.getPairOptionally(replaceDataOperation, BasicBackend.symbolByName.SourceOffset)),
                  dataLength = backend.getData(backend.getPairOptionally(replaceDataOperation, BasicBackend.symbolByName.Length)),
                  data = backend.readData(dataSource, sourceOffset, dataLength);
            return backend.decodeBinary(BasicBackend.symbolByName.UTF8, data, {'length': dataLength});
        }
    }

    function queryMethodChanges() {
        const methodsSetMap = new Map(),
              result = {};
        for(const triple of backend.queryTriples(BasicBackend.queryMasks.VMM, [BasicBackend.symbolByName.Void, BasicBackend.symbolByName.Attribute, BasicBackend.symbolByName.Method]))
            insertIntoMapOfSets(methodsSetMap,
                backend.getPairOptionally(triple[0], BasicBackend.symbolByName.Value),
                backend.getPairOptionally(BasicBackend.symbolByName.Void, triple[0], BasicBackend.queryMasks.VIM));
        for(const [methodSymbol, diffs] of [...methodsSetMap.entries()].sort((a, b) => a[1].size - b[1].size))
            result[getNameOfSymbolFromDiff(methodSymbol)] = [...diffs].map(diff => backend.getData(diff));
        return result;
    }
    console.log(performance.timerify(queryMethodChanges)());

    console.log(performanceProfile);
});
