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

#include <cstring>

char* concatenateStrings(const char* str1, const char* str2) {
    // 计算两个字符串的总长度（不包括null终止符）
    size_t len1 = strlen(str1);
    size_t len2 = strlen(str2);
    
    // 分配足够的内存来存储连接后的字符串（包括null终止符）
    char* result = new char[len1 + len2 + 1];
    
    // 复制第一个字符串
    strcpy(result, str1);
    // 连接第二个字符串
    strcat(result, str2);
    
    return result;
}

int main() {
  auto result = concatenateStrings("test", "test");
  std::cout << "Test result: " << result << std::endl;
  return 0;
}
  