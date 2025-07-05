const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Parser = require('tree-sitter');
const Cpp = require('tree-sitter-cpp');
const Python = require('tree-sitter-python');

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
//检查补全的代码是否为函数
function wrapCppFunctionForTest(code,lang) {

  switch (lang) {
    case 'python':
      // 检查是否已有 main 测试代码
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(code)) return code;

      // 简单提取函数名和参数
      const pyMatch = code.match(/def\s+(\w+)\s*\(([^)]*)\)/);
      if (!pyMatch) return code;
      const pyfuncName = pyMatch[1];
      // 生成参数填充 0
      const pyparams = pyMatch[2].split(',').map(p => p.trim() ? '0' : '').filter(Boolean).join(', ');

      // 生成 main 测试代码
      const pytestMain = `
if __name__ == "__main__":
    print("Test result:", ${pyfuncName}(${pyparams}))
        `;
      return code + '\n' + pytestMain;
    case 'javascript':
      // 检查是否有 main 测试代码
      if (/console\.log\(/.test(code)) return code;

      // 简单提取函数名和参数
      const jsMatch = code.match(/function\s+(\w+)\s*\(([^)]*)\)/);
      if (!jsMatch) return code;
      const jsfuncName = jsMatch[1];
      const jsparams = jsMatch[2].split(',').map(p => p.trim() || '0').join(', ');
      // 生成 main 测试代码
      const jstestMain = `console.log("Test result:", ${jsfuncName}(${jsparams}));`;
      return code + '\n' + jstestMain;
    case 'java':
      // Java 需要检查是否有 main 方法
      if (/public\s+static\s+void\s+main\s*\(/.test(code)) return code;
      // 简单提取函数名和参数
      const javaMatch = code.match(/(\w+)\s+(\w+)\s*\(([^)]*)\)/);
      if (!javaMatch) return code; // 不是函数，直接返回
      const javafuncName = javaMatch[2];
      const javaparams = javaMatch[3].split(',').map(p => p.trim().split(' ')[1] || '0').join(', ');
      // 生成 main 测试代码
      const javatestMain = `
public class Test {
    public static void main(String[] args) {
        ${javafuncName}(${javaparams});
    }
}
      `;
      return code + '\n' + javatestMain;
    case 'cpp':
          // 检查是否有 main 函数
      if (/int\s+main\s*\(/.test(code)) return code;

      // 用 tree-sitter 获取第一个非 main 的函数定义
      const parser = new Parser();
      parser.setLanguage(Cpp);
      const tree = parser.parse(code);
      const funcNodes = tree.rootNode.descendantsOfType('function_definition');
      if (!funcNodes.length) return code;

      // 调试输出所有函数名
      for (const node of funcNodes) {
        const decl = node.childForFieldName('declarator');
        if (!decl) continue; // 没有 declarator，跳过
        const idNode = decl ? decl.descendantsOfType('identifier')[0] : null;
        if (idNode) console.log('发现函数:', idNode.text);
      }

      // 找到第一个非 main 的函数
      let funcNode = funcNodes[0];
      for (const node of funcNodes) {
        const decl = node.childForFieldName('declarator');
        const idNode = decl ? decl.descendantsOfType('identifier')[0] : null;
        if (idNode && idNode.text !== 'main') {
          funcNode = node;
          break;
        }
      }

      // 获取参数数量
      const paramList = funcNode.childForFieldName('parameters');
      let paramCount = 0;
      let cppparams = '';
      if (paramList) {
        paramCount = paramList.namedChildCount;
        if (paramCount > 0) {
          cppparams = Array(paramCount).fill('1').join(', ');
        }
      }
      // fallback: 如果参数数量为0，尝试用正则兜底
      if (paramCount === 0) {
        const funcText = funcNode.text;
        const match = funcText.match(/\(([^)]*)\)/);
        if (match && match[1].trim()) {
          const paramListRaw = match[1].split(',').map(s => s.trim()).filter(Boolean);
          if (paramListRaw.length > 0) {
            cppparams = Array(paramListRaw.length).fill('1').join(', ');
          }
        }
      }
      // 获取函数名
      const declNode = funcNode.childForFieldName('declarator');
      let cppfuncName = 'func';
      if (declNode) {
        const idNode = declNode.descendantsOfType('identifier')[0];
        if (idNode) cppfuncName = idNode.text;
      }

      // 自动加 #include <iostream>
      let codeWithInclude = code;
      if (!/^\s*#include\s*<iostream>/m.test(code)) {
        codeWithInclude = `#include <iostream>\n${code}`;
      }

      // 生成 main 测试代码
      const cpptestMain = `
int main() {
  auto result = ${cppfuncName}(${cppparams});
  std::cout << "Test result: " << result << std::endl;
  return 0;
}
    `;
      return codeWithInclude + '\n' + cpptestMain;
    default:
      // 对于其他语言，直接返回原代码
      return code;
  }

  
}



// function getCppFunctionParams(code) {
//   const parser = new Parser();
//   parser.setLanguage(Cpp);

//   const tree = parser.parse(code);
//   const funcNode = tree.rootNode.descendantsOfType('function_definition')[0];
//   if (!funcNode) return [];

//   // 找到参数列表
//   const paramList = funcNode.childForFieldName('parameters');
//   if (!paramList) return [];

//   // 提取参数名
//   const params = [];
//   for (let i = 0; i < paramList.namedChildCount; i++) {
//     const param = paramList.namedChild(i);
//     const decl = param.descendantsOfType('identifier')[0];
//     if (decl) params.push(decl.text);
//   }
//   return params;
// }

// function generateCppInput(params) {
//   return params.map(() => '1').join(' ');
// }

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
