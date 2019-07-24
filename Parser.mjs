import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import TreeSitter from 'tree-sitter';
import TreeSitterJavaScript from 'tree-sitter-javascript';
const parser = new TreeSitter();
parser.setLanguage(TreeSitterJavaScript);

function hashOfString(string) {
    const hash = crypto.createHash('md5');
    hash.update(string, 'utf8');
    return hash.digest('hex');
}

export function parseFile(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf8'),
          ast = parser.parse(fileContent),
          cursor = ast.walk(),
          moduleEntry = {'classes': []};
    // console.log(ast.rootNode.toString());
    function nodeContent(node) {
        return fileContent.substring(node.startIndex, node.endIndex);
    }
    function methodWalk() {
        const methodEntry = {'attributes': [], 'parameters': []};
        cursor.gotoFirstChild();
        do {
            switch(cursor.currentNode.type) {
                case 'get':
                case 'set':
                case 'static':
                    methodEntry.attributes.push(cursor.currentNode.type);
                    break;
                case 'property_identifier':
                    methodEntry.identifier = nodeContent(cursor.currentNode);
                    break;
                case 'formal_parameters':
                    cursor.gotoFirstChild();
                    do {
                        switch(cursor.currentNode.type) {
                            case 'identifier':
                                const parameter = {};
                                parameter.identifier = nodeContent(cursor.currentNode);
                                methodEntry.parameters.push(parameter);
                                break;
                            case 'assignment_pattern':

                                break;
                        }
                    } while(cursor.gotoNextSibling());
                    cursor.gotoParent();
                    break;
                case 'statement_block':
                    methodEntry.body = nodeContent(cursor.currentNode);
                    methodEntry.bodyHash = hashOfString(methodEntry.body);
                    break;
            }
        } while(cursor.gotoNextSibling());
        cursor.gotoParent();
        return methodEntry;
    }
    function classWalk() {
        const classEntry = {'methods': []};
        cursor.gotoFirstChild();
        do {
            switch(cursor.currentNode.type) {
                case 'identifier':
                    classEntry.identifier = nodeContent(cursor.currentNode);
                    classEntry.identifierHash = hashOfString(classEntry.identifier);
                    break;
                case 'class_body':
                    cursor.gotoFirstChild();
                    do {
                        switch(cursor.currentNode.type) {
                            case 'method_definition':
                                const methodEntry = methodWalk();
                                methodEntry.globalIdentifier = `${classEntry.identifier}::${[...methodEntry.attributes, methodEntry.identifier].join(',')}`;
                                methodEntry.globalIdentifierHash = hashOfString(methodEntry.globalIdentifier);
                                classEntry.methods.push(methodEntry);
                                break;
                        }
                    } while(cursor.gotoNextSibling());
                    cursor.gotoParent();
                    break;
            }
        } while(cursor.gotoNextSibling());
        cursor.gotoParent();
        return classEntry;
    }
    function recursiveTreeWalk() {
        cursor.gotoFirstChild();
        do {
            switch(cursor.currentNode.type) {
                case 'export_statement':
                    recursiveTreeWalk();
                    break;
                case 'class':
                    moduleEntry.classes.push(classWalk());
                    break;
            }
        } while(cursor.gotoNextSibling());
        cursor.gotoParent();
    }
    recursiveTreeWalk();
    return moduleEntry;
}

export function exploreDirectory(directoryPath, moduleMap={}) {
    const directory = fs.readdirSync(directoryPath);
    for(const fileName of directory) {
        const filePath = directoryPath+fileName;
        if(fs.lstatSync(filePath).isDirectory())
            exploreDirectory(filePath+'/', moduleMap);
        else if(path.extname(filePath) === '.js')
            try {
                moduleMap[filePath] = parseFile(filePath);
            } catch(error) {
                console.error(filePath, error);
            }
    }
    return moduleMap;
}
