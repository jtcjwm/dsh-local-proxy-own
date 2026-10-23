import io
p = r'D:\DSH\plugins\dsh-local-proxy-own\src\index.js'
s = io.open(p, encoding='utf-8', newline='').read()

# The injected regexes lost their backslashes and became real newlines.
# Rebuild them as literal /\r?\n/.
s = s.replace("text.split(/\n?\n/)", r"text.split(/\r?\n/)")
s = s.replace("detail.split(/\n?\n/)", r"detail.split(/\r?\n/)")

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# verify no stray broken regex remains
bad = "split(/\n?\n/)"
print('remaining broken:', s.count(bad))
print('good escapes:', s.count(r"split(/\r?\n/)"))
