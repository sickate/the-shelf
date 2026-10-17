"""Bounded local EPUB extraction; legacy CLI returns label/text sections."""
import io
import json
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if tag == 'br' and not self.skip:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        if tag in ('p', 'div', 'h1', 'h2', 'h3', 'li', 'br') and not self.skip:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def extract_epub(source, located=False):
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > 10000 or sum(info.file_size for info in infos) > 40_000_000:
            raise ValueError('archive_too_large')
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise ValueError('duplicate_archive_path')

        def read(name, xml=False):
            if name.startswith('/') or '..' in name.split('/') or '\\' in name:
                raise ValueError('unsafe_archive_path')
            data = archive.read(name)
            declarations = data.upper().replace(b'\x00', b'')
            # HTMLParser never loads DTDs or external entities; XML metadata uses ET.
            if b'<!ENTITY' in declarations or (xml and b'<!DOCTYPE' in declarations):
                raise ValueError('unsafe_xml')
            return data

        container = ET.fromstring(read('META-INF/container.xml', xml=True))
        opf = next(item.attrib['full-path'] for item in container.iter() if item.tag.endswith('rootfile'))
        tree = ET.fromstring(read(opf, xml=True))
        items = {item.attrib['id']: item.attrib.get('href', '') for item in tree.iter() if item.tag.endswith('}item')}
        result = []
        text_bytes = 0
        for item in tree.iter():
            if not item.tag.endswith('}itemref'):
                continue
            href = urlsplit(items[item.attrib['idref']])
            if href.scheme or href.netloc or href.query:
                raise ValueError('unsafe_archive_path')
            name = posixpath.normpath(posixpath.join(posixpath.dirname(opf), unquote(href.path)))
            parser = Text()
            parser.feed(read(name).decode('utf-8', errors='replace'))
            text = ''.join(parser.parts)
            text_bytes += len(text.encode('utf-8'))
            if text_bytes > 20_000_000:
                raise ValueError('text_too_large')
            section = {'label': '章节 ' + str(len(result) + 1), 'text': text}
            if located:
                # Stable spine position; no local path or archive filename is published.
                section['spineIndex'] = len(result)
            result.append(section)
        return result


if __name__ == '__main__':
    located = sys.argv[1:] == ['--prepared-stdin']
    source = io.BytesIO(sys.stdin.buffer.read(20_000_001)) if located else sys.argv[1]
    print(json.dumps(extract_epub(source, located), ensure_ascii=False))
