const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Parser = require('tree-sitter');
const Cpp = require('tree-sitter-cpp');
const Python = require('tree-sitter-python');
const Java = require('tree-sitter-java');
const JavaScript = require('tree-sitter-javascript');


function detectLanguage(code, languageId) {
  if (languageId) return languageId; 
  if (/```(cpp|c\+\+)/i.test(code)) return 'cpp';
  if (/```python/i.test(code) || /import\s+.+|def\s+\w+/i.test(code)) return 'python';
  if (/```java/i.test(code) || /class\s+\w+/i.test(code)) return 'java';
  if (/```javascript/i.test(code) || /function\s+\w+|console\.log/i.test(code)) return 'javascript';
  return 'unknown';
}

function stripMarkdown(code) {
  return code.replace(/^[：:]+/gm, '') // 新增：去除每行开头的全角/半角冒号
             .replace(/```[a-zA-Z]*\n?|```/g, '')
             .trim();
}

function getTempFilePath(lang) {
  const base = path.join(__dirname, 'temp_code');
  switch (lang) {
    case 'python': return `${base}.py`;
    case 'javascript': return `${base}.js`;
    case 'cpp': return `${base}.cpp`;
    case 'java': return `${base}.java`;
    default: return `${base}.txt`;
  }
}

function getDefaultValueFromType(type) {
  if (!type) return '0';
  let rawType = type.trim()
    .replace(/\s*<\s*/g, '<')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s*\*\s*/g, '*')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ');
  const lower = rawType.toLowerCase();

  // 基础类型
  if (['int', 'long', 'short'].some(t => lower === t || lower.startsWith(t + ' '))) return '1';
  if (['float', 'double'].some(t => lower === t || lower.startsWith(t + ' '))) return '1.0';
  if (['string', 'std::string', 'str'].some(t => lower === t || lower.startsWith(t + ' '))) return '"test"';
  if (['bool', 'boolean'].includes(lower)) return 'false';

  //特殊类型
    // 指针类型判断
  if (rawType.endsWith('*') || rawType.includes('*')) {
    if (/char\*$/i.test(rawType)) return '"test"';
    if (/^[A-Z].*\*$/.test(rawType)) {
      return `new ${rawType.replace('*', '').trim()}()`;
    }
    return 'nullptr';
  }
    // vector 或数组
  if (/vector<.*>/i.test(rawType) || /\[\d*\]$/.test(rawType)) {
    const elementType = rawType.replace(/(std::)?vector<|>|\[.*\]/gi, '').trim();
    const defaultVal = getDefaultValueFromType(elementType);
    return `{${defaultVal}, ${defaultVal}}`;
  }
    // 自定义类型非指针
  if (/^[A-Z]/.test(rawType)) {
    return `${rawType}()`;
  }

  return '0';
}




function getPythonFunctionParams(code) {
  const parser = new Parser();
  parser.setLanguage(Python);
  const tree = parser.parse(code);
  const funcNode = tree.rootNode.descendantsOfType('function_definition')[0];
  if (!funcNode) return null;

  const params = funcNode.childForFieldName('parameters');
  if (!params) return [];

  const args = [];
  for (const param of params.namedChildren) {
    const nameNode = param.childForFieldName('name');
    const typeNode = param.childForFieldName('type');
    const type = typeNode ? typeNode.text : 'int'; // fallback 类型
    args.push(getDefaultValueFromType(type));
  }

  const name = funcNode.childForFieldName('name')?.text || 'func';
  return { name, args };
}



function getJavaFunctionParams(code) {
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse(code);
  const funcNode = tree.rootNode.descendantsOfType('method_declaration')[0];
  if (!funcNode) return null;

  const paramList = funcNode.childForFieldName('parameters');
  const args = [];

  if (paramList) {
    for (const param of paramList.namedChildren) {
      const typeNode = param.child(0); // 一般第一个 child 是类型
      const type = typeNode ? typeNode.text : 'int';
      args.push(getDefaultValueFromType(type));
    }
  }

  const name = funcNode.childForFieldName('name')?.text || 'func';
  return { name, args };
}



function getJSFunctionParams(code) {
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  const tree = parser.parse(code);
  const funcNode = tree.rootNode.descendantsOfType('function_declaration')[0];
  if (!funcNode) return null;

  const paramList = funcNode.childForFieldName('parameters');
  const args = [];

  if (paramList) {
    for (const param of paramList.namedChildren) {
      // JS 没类型信息，只能用默认类型
      args.push('"test"');
    }
  }

  const name = funcNode.childForFieldName('name')?.text || 'func';
  return { name, args };
}



function replaceCinWithConst(code, value = 1) {

  const parser = new Parser();
  parser.setLanguage(Cpp);
  const tree = parser.parse(code);
  const edits = [];

  function walk(node) {
    if (node.type === 'expression_statement') {
      const text = node.text;
      // 判断是否包含 std::cin 和 >>
      if (text.includes('std::cin') && text.includes('>>')) {
        const vars = [...text.matchAll(/>>\s*(\w+)/g)].map(m => m[1]);
        if (vars.length > 0) {
          const replacement = vars.map(v => `${v} = ${value};`).join('\n');
          edits.push({
            start: node.startIndex,
            end: node.endIndex,
            replacement
          });
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(tree.rootNode);

  // 按照倒序替换，避免偏移
  let newCode = code;
  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) {
    newCode =
      newCode.slice(0, edit.start) +
      edit.replacement +
      newCode.slice(edit.end);
  }
  if (edits.length === 0) {
    return replaceCinWithConstPlus(code, value); 
  }
  return newCode;
}
  
//正则兜底
function replaceCinWithConstPlus(code, value = 1) {
  return code.replace(/std::cin\s*>>\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*>>\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*;/g, (match, vars) => {
    return vars.split('>>').map(v => v.trim() + ' = ' + value + ';').join(' ');
  });
}

function autoAddCommonIncludes(code) {
  const commonHeadersText = `\
#include <iostream>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <unordered_map>
#include <set>
#include <algorithm>
#include <cmath>
#include <cassert>
#include <functional>
#include <memory>
#include <thread>
#include <mutex>
#include <chrono>
`;

  return commonHeadersText + '\n' + code;
}


//检查补全的代码是否为函数
function wrapCppFunctionForTest(code,lang) {

  switch (lang) {

    case 'python': {
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(code)) return code;
      const funcInfo = getPythonFunctionParams(code);
      if (!funcInfo) return code;

      const { name, args } = funcInfo;
      const testMain = `
if __name__ == "__main__":
print("Test result:", ${name}(${args.join(', ')}))
      `;
      return code + '\n' + testMain;
    }

    case 'javascript': {
      if (/console\.log\(/.test(code)) return code;
      const funcInfo = getJSFunctionParams(code);
      if (!funcInfo) return code;

      const { name, args } = funcInfo;
      const testMain = `console.log("Test result:", ${name}(${args.join(', ')}));`;
      return code + '\n' + testMain;
    }

    case 'java': {
      if (/public\s+static\s+void\s+main\s*\(/.test(code)) return code;
      const funcInfo = getJavaFunctionParams(code);
      if (!funcInfo) return code;

      const { name, args } = funcInfo;
      const testMain = `
public class Test {
    public static void main(String[] args) {
        System.out.println(${name}(${args.join(', ')}));
    }
}
      `;
      return code + '\n' + testMain;
    }

    case 'cpp': {
      // 测试类型映射正确性（可选，开发调试时保留）
      [
        "int", 
        "float", 
        "bool", 
        "string", 
        "std::string", 
        "const char*", 
        "char*", 
        "int*", 
        "std::vector<int>", 
        "MyClass", 
        "MyClass*"
      ].forEach(t => {
        console.log(`${t} => ${getDefaultValueFromType(t)}`);
      });

      code = replaceCinWithConst(code);

      // 如果已有 main 函数，直接返回
      if (/int\s+main\s*\(/.test(code)) return code;

      const parser = new Parser();
      parser.setLanguage(Cpp);
      const tree = parser.parse(code);
      const funcNodes = tree.rootNode.descendantsOfType('function_definition');
      if (!funcNodes.length) return code;

      // // 找第一个非 main 的函数
      let funcNode = funcNodes[0];
      // for (const node of funcNodes) {
      //   const decl = node.childForFieldName('declarator');
      //   const idNode = decl ? decl.descendantsOfType('identifier')[0] : null;
      //   if (idNode && idNode.text !== 'main') {
      //     funcNode = node;
      //     break;
      //   }
      // }
      console.log(funcNode.toString());
      // 获取函数参数
      
      const args = [];
      const charPtrBuffers = []; 

      let declNode = funcNode.childForFieldName('declarator'); // pointer_declarator
      // pointer_declarator 内部的 declarator 是 function_declarator
      const funcDeclNode = declNode?.childForFieldName('declarator'); // function_declarator
      const paramList = funcDeclNode?.childForFieldName('parameters');

      function collectTypeTokens(node, tokens = []) {
  const allowedTypes = new Set([
    'type_identifier',
    'primitive_type',
    'template_type',
    'qualified_identifier',
    'type_qualifier',
    'reference',
    'const',
  ]);

  if (allowedTypes.has(node.type) || node.text === '*' || node.text === '&') {
    tokens.push(node.text);
  }

  // 递归遍历所有子节点
  for (let i = 0; i < node.childCount; i++) {
    collectTypeTokens(node.child(i), tokens);
  }

  return tokens;
}

// 使用示例
if (paramList) {
  for (const param of paramList.namedChildren) {
    const typeTokens = collectTypeTokens(param);
    let type = typeTokens.join(' ').trim();

    type = type
      .replace(/\s*<\s*/g, '<')
      .replace(/\s*>\s*/g, '>')
      .replace(/\s*\*\s*/g, '*')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ');
    const defaultVal = getDefaultValueFromType(type);
    console.log('Parsed param type:', type);
    if (/^char\s*\*$/i.test(type)) {
      const varName = `charBuffer${idx}`;
      charPtrBuffers.push(`char ${varName}[100] = "test";`);
      args.push(varName);
    } else {
      args.push(defaultVal);
    }
  }
} else {
  console.log('No parameters found!');
}



      // fallback：正则兜底处理
      if (args.length === 0) {
        const funcText = funcNode.text;
        const match = funcText.match(/\(([^)]*)\)/);
        if (match && match[1].trim()) {
          const paramListRaw = match[1].split(',').map(s => s.trim()).filter(Boolean);
          if (paramListRaw.length > 0) {
            args.push(...Array(paramListRaw.length).fill('1'));
          }
        }
      }

      // 获取函数名
      declNode = funcNode.childForFieldName('declarator');
      let cppfuncName = 'func';
      if (declNode) {
        const idNode = declNode.descendantsOfType('identifier')[0];
        if (idNode) cppfuncName = idNode.text;
      }

      // 加头文件
      let codeWithInclude = autoAddCommonIncludes(code);

      // 生成 main 函数
      const cpptestMain = `
int main() {
  auto result = ${cppfuncName}(${args.join(', ')});
  std::cout << "Test result: " << result << std::endl;
  return 0;
}
  `;

      return codeWithInclude + '\n' + cpptestMain;
    }

  }
}




function runCode(lang, code) {
  return new Promise((resolve) => {
    const cleanedCode = stripMarkdown(code);
    const recleanedCode = wrapCppFunctionForTest(cleanedCode,lang);
    const filePath = getTempFilePath(lang);
    fs.writeFileSync(filePath, recleanedCode);

    let command = '';
    switch (lang) {
      case 'python':
        command = `python3 ${filePath}`;
        break;
      case 'javascript':
        command = `node ${filePath}`;
        break;
      case 'cpp':
        console.log('当前 PATH:', process.env.PATH);
        const exePath = `${filePath}.exe`;
        command = `g++ "${filePath}" -o "${exePath}" && "${exePath}"`;
        break;
      case 'java':
        command = `javac ${filePath} && java -cp ${path.dirname(filePath)} ${path.basename(filePath).replace('.java', '')}`;
        break;
      default:
        return resolve({ success: false, message: '不支持的语言类型。' });
    }

    exec(command, (error, stdout, stderr) => {
      console.log('error:', error);
      console.log('stdout:', stdout);
      console.log('stderr:', stderr);
      if (error && error.code !== 0) {
        resolve({ success: false, message: stderr || error.message });
      } else {
        resolve({ success: true, message: stdout });
      }
    });
  });
}

async function extractStructureSummary(fileContent, fileName) {
  const parser = new Parser();
  let lang = null;
  if (fileName.endsWith('.py')) {
    lang = Python;
  } else if (fileName.endsWith('.cpp') || fileName.endsWith('.cc') || fileName.endsWith('.cxx') || fileName.endsWith('.hpp') || fileName.endsWith('.h')) {
    lang = Cpp;
  } else {
    lang = Python; // 默认兜底
  }
  parser.setLanguage(lang);
  const tree = parser.parse(fileContent);
  const summary = [];
  function walk(node) {
    // C++: #include
    if (node.type === 'preproc_call') {
      summary.push(`#include: ${node.text}`);
    }
    // 注释
    if (node.type === 'comment') {
      summary.push(`注释: ${node.text}`);
    }
    // Python/C++: 函数
    if (node.type === 'function_definition') {
      let name = '';
      // Python: name 字段，C++: declarator/identifier
      if (node.childForFieldName && node.childForFieldName('name')) {
        name = node.childForFieldName('name').text;
      } else if (node.childForFieldName && node.childForFieldName('declarator')) {
        const decl = node.childForFieldName('declarator');
        const idNode = decl ? decl.descendantsOfType('identifier')[0] : null;
        name = idNode ? idNode.text : '匿名';
      } else {
        name = '匿名';
      }
      summary.push(`函数: ${name}`);
    }
    // Python: 类
    if (node.type === 'class_definition') {
      let name = '匿名';
      // 方法1：直接取 name 字段（适用于Python）
      if (node.childForFieldName('name')) {
        name = node.childForFieldName('name').text;
      } 
      // 方法2：遍历查找 identifier（备用方案）
      else {
        const idNode = node.descendantsOfType('identifier')[0];
        if (idNode) name = idNode.text;
      }
      summary.push(`类: ${name}`);
    }
    // C++: 类
    if (node.type === 'class_specifier') {
      let name = '';
      const idNode = node.descendantsOfType('type_identifier')[0];
      name = idNode ? idNode.text : '匿名';
      summary.push(`类: ${name}`);
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }
  walk(tree.rootNode);
  return `【${fileName}结构摘要】\n` + summary.join('\n');
}

module.exports = {
  detectLanguage,
  runCode,
  extractStructureSummary
};

