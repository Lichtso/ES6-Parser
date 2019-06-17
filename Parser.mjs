import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

function hashOfString(string) {
    const hash = crypto.createHash('md5');
    hash.update(string, 'utf8');
    return hash.digest('hex');
}

export class ES6ModuleParser {
    constructor(path, sourceCode) {
        this.name = path;
        this.nameHash = hashOfString(path);
        this.directory = path.replace(/[^\/]+\.[^\/]+$/, '');
        this.sourceCode = sourceCode;
        this.eventStream = [];
        this.importPaths = [];
        this.classes = {};
        this.runLexerRegularExpression();
        this.runLexerStackMachine();
        this.parseModule();
    }

    runLexerRegularExpression() {
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Lexical_grammar
        const regex = /(\/{2}[^\n]*(?:\n|$))|(\/\*(?:(?!\*\/).)*\*\/)|(?<=[=(),?:]|return|yield)(\s*\/(?:(?:(?:\[[^\]]*\])|[^\/\\\n])+(?:\\.(?:(?:\[[^\]]*\])|[^\/\\\n])*)*|(?:(?:\[[^\]]*\])|[^\/\\\n])*(?:\\.(?:(?:\[[^\]]*\])|[^\/\\\n])*)+)\/[gmiyus]*)(?=\s*[\n;),.?:])|(`[^`\\]*(?:\\.[^`\\]*)*`)|('[^'\\\n]*(?:\\.[^'\\\n]*)*')|("[^"\\\n]*(?:\\.[^"\\\n]*)*")|(?:(?<!\w)(class|import)(?!\w))/gs;
        let match;
        while((match = regex.exec(this.sourceCode))) {
            const type = match.findIndex((element, index) => element && index > 0);
            this.eventStream.push({
                'offset': (match[0].length == match[type].length) ? match.index : this.sourceCode.indexOf(match[type], match.index),
                'length': match[type].length,
                'type': (type == 7) ? match[0] : type
            });
        }
    }

    runLexerStackMachine() {
        const bracketTypes = {'{': '{}', '}': '{}', '(': '()', ')': '()', '[': '[]', ']': '[]'},
              bracketStack = [];
        let eventIndex = 0;
        this.lineCount = 1;
        for(let offset = 0; offset < this.sourceCode.length; ++offset) {
            const event = this.eventStream[eventIndex];
            if(event && event.offset == offset) {
                const lineEnds = this.sourceCode.substr(event.offset, event.length).match(/\n/g);
                if(lineEnds)
                    this.lineCount += lineEnds.length-1;
                offset += event.length-1;
                ++eventIndex;
                continue;
            }
            const character = this.sourceCode[offset]; // this.sourceCode.charCodeAt(offset);
            switch(character) {
                case '\n':
                    ++this.lineCount;
                    break;
                case '{':
                case '(':
                case '[': {
                    const type = bracketTypes[character],
                          event = {
                        'offset': offset,
                        'length': -offset-1,
                        'type': type,
                        'lineIndex': this.lineCount,
                        'beginIndex': eventIndex
                    };
                    bracketStack.push(event);
                    this.eventStream.splice(eventIndex++, 0, event);
                } break;
                case '}':
                case ')':
                case ']':{
                    const type = bracketTypes[character],
                          event = bracketStack.pop();
                    if(!event || event.type != type)
                        throw new Error(`Closing bracket mismatch ${type} at ${offset} ${this.lineCount} ${this.sourceCode.substr(offset, 100)}`);
                    event.length += offset;
                    event.endIndex = eventIndex;
                    this.eventStream.splice(eventIndex++, 0, event);
                } break;
            }
        }
        if(bracketStack.length > 0)
            throw new Error(`Unmatched opening bracket ${bracketStack[0].type}`);
    }

    parseClass(eventIndex) {
        const classObject = {'beginIndex': eventIndex, 'methods': {}},
              classKeywordEvent = this.eventStream[eventIndex++],
              classBodyEvent = this.eventStream[eventIndex++];
        if(classBodyEvent.type != '{}')
            throw new Error(`class keyword is not followed by a {} block begin at ${classKeywordEvent.offset} ${classKeywordEvent.lineIndex}`);
        const classDeclaration = /\s*(\w+)\s*(?:extends\s+(\w+)\s*)?/.exec(this.sourceCode.substring(classKeywordEvent.offset+classKeywordEvent.length, classBodyEvent.offset));
        if(!classDeclaration)
            throw new Error(`could not extract class declaration at ${classKeywordEvent.offset} ${classKeywordEvent.lineIndex}`);
        classObject.name = classDeclaration[1];
        classObject.nameHash = hashOfString(classObject.name);
        if(classDeclaration[2])
            classObject.extends = classDeclaration[2];
        this.classes[classObject.name] = classObject;
        for(; eventIndex < this.eventStream.length; ++eventIndex) {
            const event = this.eventStream[eventIndex];
            if(event == classBodyEvent)
                break;
            let parameterListEvent, bodyEvent;
            switch(event.type) {
                case 1:
                case 2:
                    continue;
                case '()':
                    parameterListEvent = event;
                    eventIndex = parameterListEvent.endIndex;
                    do {
                        bodyEvent = this.eventStream[++eventIndex];
                    } while(bodyEvent.type == 1 || bodyEvent.type == 2);
                    if(bodyEvent.type != '{}')
                        throw new Error(`methods parameter brackets are not followed by a body at ${event.offset} ${event.lineIndex}`);
                    break;
                case '{}':
                    bodyEvent = event;
                    break;
                default:
                    throw new Error(`unexpected token of type ${event.type} at ${event.offset} ${event.lineIndex}`);
            }
            if(!parameterListEvent)
                throw new Error(`expected a parameter list at ${event.offset} ${event.lineIndex}`);
            const body = this.sourceCode.substr(bodyEvent.offset, bodyEvent.length),
                  prevEvent = this.eventStream[parameterListEvent.beginIndex-1],
                  lastOffset = prevEvent.offset+((classBodyEvent == prevEvent) ? 0 : prevEvent.length)+1,
                  attributeString = this.sourceCode.substring(lastOffset, parameterListEvent.offset).trim(),
                  attributeList = [],
                  regex = /\s*(\w+)\s*/g;
            let match;
            while((match = regex.exec(attributeString)))
                attributeList.push(match[1]);
            eventIndex = parameterListEvent.beginIndex+1;
            let parameterString = '', offset = parameterListEvent.offset+1;
            while(eventIndex < parameterListEvent.endIndex) {
                parameterString += this.sourceCode.substring(offset, this.eventStream[eventIndex].offset);
                offset = this.eventStream[eventIndex].offset+this.eventStream[eventIndex].length;
                if(this.eventStream[eventIndex].endIndex) {
                    eventIndex = this.eventStream[eventIndex].endIndex+1;
                    offset += 2;
                } else
                    ++eventIndex;
            }
            parameterString += this.sourceCode.substring(offset, parameterListEvent.offset+parameterListEvent.length+1);
            const parameters = parameterString.split(','),
                  name = attributeList.join(' ');
            if(parameters[parameters.length-1].match(/^\s*$/))
                parameters.pop();
            classObject.methods[name] = {
                'beginIndex': event.beginIndex,
                'name': name,
                'nameHash': hashOfString(classObject.name+'::'+name),
                'bareName': attributeList[attributeList.length-1],
                'attributes': attributeList.slice(0, -1),
                // 'parameters': parameters.map(str => /\s*(\w+)\s*.*/.exec(str)[1]),
                'sourceCode': body,
                'bodyHash': hashOfString(body)
            };
            eventIndex = bodyEvent.endIndex;
        }
        return eventIndex;
    }

    parseModule() {
        for(let eventIndex = 0; eventIndex < this.eventStream.length; ++eventIndex) {
            const event = this.eventStream[eventIndex];
            switch(event.type) {
                case 'import': {
                    let pathEvent = this.eventStream[eventIndex+1];
                    if(pathEvent.type == '()')
                        pathEvent = this.eventStream[eventIndex+2];
                    else if(pathEvent.type == '{}')
                        pathEvent = this.eventStream[pathEvent.endIndex+1];
                    if(pathEvent.type != 5 && pathEvent.type != 6)
                        throw new Error(`cannot find path after import keyword at ${pathEvent.offset} ${pathEvent.lineIndex}`);
                    let path = this.directory+this.sourceCode.substr(pathEvent.offset+1, pathEvent.length-2), flag = true;
                    while(flag) {
                        flag = false;
                        path = path.replace(/\w+\/\.+\//, function(x) { flag = true; return ''; });
                    }
                    this.importPaths.push(path);
                } break;
                case 'class':
                    eventIndex = this.parseClass(eventIndex);
                    break;
                case '{}':
                    // console.log('Possible method', event, this.sourceCode.substr(event.offset, 100));
                    eventIndex = event.endIndex;
                    break;
            }
        }
    }
}

export function exploreDirectory(directoryPath, moduleMap={}) {
    const directory = fs.readdirSync(directoryPath);
    for(const fileName of directory) {
        const filePath = directoryPath+fileName;
        if(fs.lstatSync(filePath).isDirectory())
            exploreDirectory(filePath+'/', moduleMap);
        else if(path.extname(filePath) === '.js')
            try {
                moduleMap[filePath] = new ES6ModuleParser(filePath, fs.readFileSync(filePath, 'utf8'));
            } catch(error) {
                console.error(filePath, error);
            }
    }
    return moduleMap;
}
