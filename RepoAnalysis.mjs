import process from 'process';
import path from 'path';
import fs from 'fs';
import {performance} from 'perf_hooks';

import {Namespaces} from './Config.mjs';
import {performanceProfile, formatMemoryUsage, insertIntoMapOfSets} from './Utils.mjs';
import {loaded, BasicBackend, JavaScriptBackend, RustWasmBackend, Diff, Repository} from 'SymatemJS';

let repository, backend, diffsPath;

function analyzeTripleOperations(operations) {
    const accumulator = {'Module': 0, 'Class': 0, 'Method': 0, 'MethodBody': 0};
    if(operations)
        for(const operation of operations)
            for(const type in accumulator)
                if(operation.triple[1] == backend.symbolByName[type])
                    ++accumulator[type];
    return accumulator;
}

function loadRepository() {
    backend.decodeJson(fs.readFileSync(path.join(diffsPath, 'repository.json'), 'utf8'));
    for(const edge of repository.getEdges()) {
        const diffSymbol = backend.getPairOptionally(edge, backend.symbolByName.Diff);
        if(diffSymbol != backend.symbolByName.Void && diffSymbol != backend.symbolByName.Diff) {
            const parentVersion = backend.getPairOptionally(edge, backend.symbolByName.Parent),
                  childVersion = backend.getPairOptionally(edge, backend.symbolByName.Child),
                  name = `${backend.getData(parentVersion)}-${backend.getData(childVersion)}`,
                  diff = new Diff(backend, repository.namespace, repository.relocationTable, diffSymbol);
            backend.setData(diff.symbol, name);
            console.log(name,
                analyzeTripleOperations(diff.postCommitStructure.linkTripleOperations),
                analyzeTripleOperations(diff.postCommitStructure.unlinkTripleOperations)
            );
        }
    }
}

function getNameOfSymbolFromDiff(symbol) {
    for(const triple of backend.queryTriples(BasicBackend.queryMasks.VMM, [backend.symbolByName.Void, backend.symbolByName.Destination, symbol])) {
        const replaceDataOperation = triple[0],
              differentalSymbol = backend.getPairOptionally(backend.symbolByName.ReplaceData, replaceDataOperation, BasicBackend.queryMasks.VMM);
        if(differentalSymbol == backend.symbolByName.Void)
            continue;
        const dataSource = backend.getPairOptionally(differentalSymbol, backend.symbolByName.DataSource),
              sourceOffset = backend.getData(backend.getPairOptionally(replaceDataOperation, backend.symbolByName.SourceOffset)),
              dataLength = backend.getData(backend.getPairOptionally(replaceDataOperation, backend.symbolByName.Length)),
              data = backend.readData(dataSource, sourceOffset, dataLength);
        return backend.decodeBinary(backend.symbolByName.UTF8, data, {'length': dataLength});
    }
}

function queryMethodChanges() {
    const methodsSetMap = new Map(),
          result = {};
    for(const triple of backend.queryTriples(BasicBackend.queryMasks.VMM, [backend.symbolByName.Void, backend.symbolByName.Attribute, backend.symbolByName.Method])) {
        insertIntoMapOfSets(methodsSetMap,
            backend.getPairOptionally(triple[0], backend.symbolByName.Value),
            backend.getPairOptionally(backend.symbolByName.Void, triple[0], BasicBackend.queryMasks.VIM));
    }
    for(const [methodSymbol, diffs] of [...methodsSetMap.entries()].sort((a, b) => a[1].size - b[1].size))
        result[getNameOfSymbolFromDiff(methodSymbol)] = [...diffs].map(diff => backend.getData(diff));
    return result;
}

loaded.then(() => {
    backend = new RustWasmBackend();
    backend.initPredefinedSymbols();
    const namespaces = backend.registerNamespaces(Namespaces);
    repository = new Repository(backend, namespaces.Repository, {[namespaces.Recording]: namespaces.Modal});

    const pwdPath = path.dirname(process.argv[1]);
    diffsPath = path.join(pwdPath, 'diffs');
    performance.timerify(loadRepository)();
    console.log(`JS-heap: ${formatMemoryUsage(process.memoryUsage().heapUsed, 4294967296)}, WASM: ${formatMemoryUsage(backend.getMemoryUsage(), 4294967296)}`);

    let repoSymbolCount = 0, modalSymbolCount = 0, tripleCount = 0;
    for(const symbol of backend.querySymbols(namespaces.Repository))
        ++repoSymbolCount;
    for(const symbol of backend.querySymbols(namespaces.Modal))
        ++modalSymbolCount;
    for(const triple of backend.queryTriples(BasicBackend.queryMasks.VVV, [backend.symbolByName.Void, backend.symbolByName.Void, backend.symbolByName.Void]))
        ++tripleCount;
    console.log(`${repoSymbolCount} Repository Symbols, ${modalSymbolCount} Modal Symbols, ${tripleCount} Triples`);

    console.log(performance.timerify(queryMethodChanges)());

    console.log(performanceProfile);
});
