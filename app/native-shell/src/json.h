// JSON mínimo (parser + serializador) para el protocolo JSON-lines con el motor.
// Header-only, sin dependencias. Soporta el subconjunto completo de RFC 8259
// que usa el motor: null/bool/number/string/array/object, escapes \uXXXX con
// pares sustitutos, y salida compacta en una sola línea.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace voxora::json {

class Value;
using Array = std::vector<Value>;
using Object = std::map<std::string, Value>;

class Value {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Value() = default;
  Value(std::nullptr_t) {}
  Value(bool b) : type_(Type::Bool), bool_(b) {}
  Value(int n) : type_(Type::Number), number_(n) {}
  Value(unsigned n) : type_(Type::Number), number_(n) {}
  Value(int64_t n) : type_(Type::Number), number_(static_cast<double>(n)) {}
  Value(double n) : type_(Type::Number), number_(n) {}
  Value(const char* s) : type_(Type::String), string_(s) {}
  Value(std::string s) : type_(Type::String), string_(std::move(s)) {}
  Value(Array a) : type_(Type::Array), array_(std::make_shared<Array>(std::move(a))) {}
  Value(Object o) : type_(Type::Object), object_(std::make_shared<Object>(std::move(o))) {}

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isBool() const { return type_ == Type::Bool; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isString() const { return type_ == Type::String; }
  bool isArray() const { return type_ == Type::Array; }
  bool isObject() const { return type_ == Type::Object; }

  bool asBool(bool fallback = false) const { return isBool() ? bool_ : fallback; }
  double asNumber(double fallback = 0) const { return isNumber() ? number_ : fallback; }
  int asInt(int fallback = 0) const { return isNumber() ? static_cast<int>(std::llround(number_)) : fallback; }
  const std::string& asString() const {
    static const std::string empty;
    return isString() ? string_ : empty;
  }
  std::string asString(const std::string& fallback) const { return isString() ? string_ : fallback; }
  const Array& asArray() const {
    static const Array empty;
    return isArray() ? *array_ : empty;
  }
  const Object& asObject() const {
    static const Object empty;
    return isObject() ? *object_ : empty;
  }

  // Acceso a miembros (devuelve Null si no existe / no es objeto).
  const Value& operator[](const std::string& key) const {
    static const Value nullValue;
    if (!isObject()) return nullValue;
    auto it = object_->find(key);
    return it == object_->end() ? nullValue : it->second;
  }
  const Value& operator[](size_t index) const {
    static const Value nullValue;
    if (!isArray() || index >= array_->size()) return nullValue;
    return (*array_)[index];
  }
  bool has(const std::string& key) const { return isObject() && object_->count(key) > 0; }

  // Mutación de objetos/arrays (crea la estructura si es Null).
  Value& set(const std::string& key, Value v) {
    if (!isObject()) {
      type_ = Type::Object;
      object_ = std::make_shared<Object>();
    }
    (*object_)[key] = std::move(v);
    return *this;
  }
  Value& push(Value v) {
    if (!isArray()) {
      type_ = Type::Array;
      array_ = std::make_shared<Array>();
    }
    array_->push_back(std::move(v));
    return *this;
  }

  std::string dump() const {
    std::string out;
    dumpTo(out);
    return out;
  }

  void dumpTo(std::string& out) const {
    switch (type_) {
      case Type::Null: out += "null"; break;
      case Type::Bool: out += bool_ ? "true" : "false"; break;
      case Type::Number: {
        if (std::isfinite(number_)) {
          if (number_ == std::floor(number_) && std::fabs(number_) < 1e15) {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(number_));
            out += buf;
          } else {
            char buf[40];
            std::snprintf(buf, sizeof(buf), "%.17g", number_);
            out += buf;
          }
        } else {
          out += "null";
        }
        break;
      }
      case Type::String: escapeTo(out, string_); break;
      case Type::Array: {
        out += '[';
        bool first = true;
        for (const auto& v : *array_) {
          if (!first) out += ',';
          first = false;
          v.dumpTo(out);
        }
        out += ']';
        break;
      }
      case Type::Object: {
        out += '{';
        bool first = true;
        for (const auto& [k, v] : *object_) {
          if (!first) out += ',';
          first = false;
          escapeTo(out, k);
          out += ':';
          v.dumpTo(out);
        }
        out += '}';
        break;
      }
    }
  }

  static void escapeTo(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
          if (c < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
          } else {
            out += static_cast<char>(c);
          }
      }
    }
    out += '"';
  }

 private:
  Type type_ = Type::Null;
  bool bool_ = false;
  double number_ = 0;
  std::string string_;
  std::shared_ptr<Array> array_;
  std::shared_ptr<Object> object_;
};

class ParseError : public std::runtime_error {
 public:
  explicit ParseError(const std::string& what) : std::runtime_error(what) {}
};

class Parser {
 public:
  static Value parse(const std::string& text) {
    Parser p(text);
    p.skipWs();
    Value v = p.parseValue();
    p.skipWs();
    if (p.pos_ != p.text_.size()) p.fail("caracteres sobrantes");
    return v;
  }

 private:
  explicit Parser(const std::string& text) : text_(text) {}

  [[noreturn]] void fail(const char* what) {
    throw ParseError(std::string("JSON: ") + what + " en posición " + std::to_string(pos_));
  }

  void skipWs() {
    while (pos_ < text_.size() && (text_[pos_] == ' ' || text_[pos_] == '\n' || text_[pos_] == '\r' || text_[pos_] == '\t')) pos_++;
  }

  char peek() const { return pos_ < text_.size() ? text_[pos_] : '\0'; }

  bool consume(const char* literal) {
    size_t n = std::char_traits<char>::length(literal);
    if (text_.compare(pos_, n, literal) == 0) {
      pos_ += n;
      return true;
    }
    return false;
  }

  Value parseValue() {
    switch (peek()) {
      case 'n': if (consume("null")) return Value(); break;
      case 't': if (consume("true")) return Value(true); break;
      case 'f': if (consume("false")) return Value(false); break;
      case '"': return Value(parseString());
      case '[': return parseArray();
      case '{': return parseObject();
      default: if (peek() == '-' || (peek() >= '0' && peek() <= '9')) return parseNumber(); break;
    }
    fail("valor inesperado");
  }

  Value parseNumber() {
    size_t start = pos_;
    if (peek() == '-') pos_++;
    while (pos_ < text_.size() && ((text_[pos_] >= '0' && text_[pos_] <= '9') || text_[pos_] == '.' || text_[pos_] == 'e' || text_[pos_] == 'E' || text_[pos_] == '+' || text_[pos_] == '-')) pos_++;
    std::string token = text_.substr(start, pos_ - start);
    char* end = nullptr;
    double v = std::strtod(token.c_str(), &end);
    if (!end || *end != '\0' || token.empty()) fail("número inválido");
    return Value(v);
  }

  static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }

  uint32_t parseHex4() {
    if (pos_ + 4 > text_.size()) fail("escape \\u truncado");
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
      char c = text_[pos_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else fail("escape \\u inválido");
    }
    return v;
  }

  std::string parseString() {
    if (peek() != '"') fail("se esperaba comilla");
    pos_++;
    std::string out;
    while (true) {
      if (pos_ >= text_.size()) fail("cadena sin cerrar");
      char c = text_[pos_++];
      if (c == '"') break;
      if (c != '\\') {
        out += c;
        continue;
      }
      if (pos_ >= text_.size()) fail("escape truncado");
      char e = text_[pos_++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp = parseHex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && consume("\\u")) {
            uint32_t low = parseHex4();
            if (low >= 0xDC00 && low <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            else appendUtf8(out, cp), cp = low;
          }
          appendUtf8(out, cp);
          break;
        }
        default: fail("escape desconocido");
      }
    }
    return out;
  }

  Value parseArray() {
    pos_++;  // [
    Array items;
    skipWs();
    if (peek() == ']') {
      pos_++;
      return Value(std::move(items));
    }
    while (true) {
      skipWs();
      items.push_back(parseValue());
      skipWs();
      if (peek() == ',') { pos_++; continue; }
      if (peek() == ']') { pos_++; break; }
      fail("se esperaba , o ]");
    }
    return Value(std::move(items));
  }

  Value parseObject() {
    pos_++;  // {
    Object items;
    skipWs();
    if (peek() == '}') {
      pos_++;
      return Value(std::move(items));
    }
    while (true) {
      skipWs();
      std::string key = parseString();
      skipWs();
      if (peek() != ':') fail("se esperaba :");
      pos_++;
      skipWs();
      items[key] = parseValue();
      skipWs();
      if (peek() == ',') { pos_++; continue; }
      if (peek() == '}') { pos_++; break; }
      fail("se esperaba , o }");
    }
    return Value(std::move(items));
  }

  const std::string& text_;
  size_t pos_ = 0;
};

inline Value parse(const std::string& text) { return Parser::parse(text); }

}  // namespace voxora::json
