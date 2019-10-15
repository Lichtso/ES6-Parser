import path from 'path';
import fs from 'fs';
import TreeSitter from 'tree-sitter';
import TreeSitterJavaScript from 'tree-sitter-javascript';
const parser = new TreeSitter();
parser.setLanguage(TreeSitterJavaScript);

export function parseFile(filePath, fileContent) {
    if(!fileContent) {
        if(!fs.existsSync(filePath))
            return;
        fileContent = fs.readFileSync(filePath, 'utf8');
    }
    const ast = parser.parse(fileContent),
          cursor = ast.walk(),
          moduleEntry = {'identifier': filePath, 'classes': {}};
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
                    break;
            }
        } while(cursor.gotoNextSibling());
        cursor.gotoParent();
        return methodEntry;
    }
    function classWalk() {
        const classEntry = {'methods': {}};
        cursor.gotoFirstChild();
        do {
            switch(cursor.currentNode.type) {
                case 'identifier':
                    classEntry.identifier = nodeContent(cursor.currentNode);
                    break;
                case 'class_body':
                    cursor.gotoFirstChild();
                    do {
                        switch(cursor.currentNode.type) {
                            case 'method_definition':
                                const methodEntry = methodWalk();
                                methodEntry.globalIdentifier = `${classEntry.identifier}::${[...methodEntry.attributes, methodEntry.identifier].join(',')}`;
                                if(methodEntry.identifier)
                                    classEntry.methods[methodEntry.globalIdentifier] = methodEntry;
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
                case 'class_declaration':
                    const classEntry = classWalk();
                    if(classEntry.identifier)
                        moduleEntry.classes[classEntry.identifier] = classEntry;
                    break;
            }
        } while(cursor.gotoNextSibling());
        cursor.gotoParent();
    }
    recursiveTreeWalk();
    return moduleEntry;
}
