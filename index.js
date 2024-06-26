// noinspection NonAsciiCharacters,ExceptionCaughtLocallyJS,JSUnresolvedReference

const fs = require('fs');
const path = require('path');
const {pipeline} = require('stream');
const {promisify} = require('util');
const axios = require('axios');
const cheerio = require('cheerio');
import('node-fetch');
const sqlString = require('sqlstring');

const LIST_URL = 'https://www.mmca.go.kr/collections/AjaxCollectionsList.do?'
    + 'pageOrder=Wrkinfo_Seqno&'
    + 'pageIndex=%pageIndex&'
    + 'searchWrkFieldGb=%searchWrkFieldGb';
const DETAIL_URL = 'https://www.mmca.go.kr/collections/collectionsDetailPage.do?'
    + 'museumId=%museumId&'
    + 'wrkinfoSeqno=%wrkinfoSeqno&'
    + 'artistnm=%artistnm&'
    + 'wrkMngNo=%wrkMngNo';
const INSERT_PREFIX = 'INSERT INTO artwork (name, category, artist, year, material, size, content, image, savefilename)\nVALUES ';

function escape(value, length = 9999) {
    return sqlString.escape(value
        .trim()
        .replaceAll('×', 'x')
        .replaceAll(';', ' ')
        .substring(0, length));
}

function sanitizeFileName(fileName) {
    const reservedNames = [
        'AUX', 'CON', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'PRN', 'NUL', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    ];

    const ext = path.extname(fileName);
    let baseName = path.basename(fileName, ext);

    if (reservedNames.includes(baseName.toUpperCase())) {
        baseName += '_';
    }

    baseName = baseName.replaceAll(/[\\/:*?#'"<>|]/g, '_')

    return baseName + ext;
}

const ARTWORK_CATEGORY = ['회화', '드로잉', '판화', '조각ㆍ설치', '사진', '공예', '디자인', '서예'];

async function fetchData(url, downloadImage = false) {
    const pageResponse = await fetch(url);

    if (!pageResponse.ok) {
        console.error('Server Error:', pageResponse.status);
        return;
    }

    const data = await pageResponse.json();
    const collectionsList = data.collectionsList;
    const promises = [];

    const saveDir = path.join(__dirname, 'artwork');
    if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir);
    }
    for (const collection of collectionsList) {
        const artist = collection.artistnm ? collection.artistnm + ' ' + collection.artistnmEng : "작자미상";
        const name = collection.wrkNm;
        const year = collection.wrkProdTermEnd ?? "연도미상";

        console.log(`'${name}' 예술품의 데이터 수집을 시작합니다.`);
        promises.push(new Promise(async (resolve) => {
            try {
                const url = DETAIL_URL
                    .replace('%museumId', collection.museumId)
                    .replace('%wrkinfoSeqno', collection.wrkinfoSeqno)
                    .replace('%artistnm', collection.artistnm)
                    .replace('%wrkMngNo', collection.wrkMngNo);

                const detailResponse = await axios.get(url);
                if (detailResponse.status !== 200) {
                    throw new Error('Failed load detail page');
                }

                const $ = cheerio.load(detailResponse.data);
                const description = $(
                    $('#content .contTextWrap .txtArea, #content .contTextWrap .txtArea p').toArray().reverse()[0]
                ).text();
                const info = Object.fromEntries(
                    $('#content .artInfo dl')
                        .toArray()
                        .map(element => [$(element.children[1]).text(), $(element.children[3]).text()])
                );

                let category = info.부문.replaceAll('I', '').trim();
                if (!ARTWORK_CATEGORY.includes(category)) {
                    throw new Error('Invalid artwork category : ' + category);
                }

                const imgFileUrl = collection.imageQuaOrg;
                if (!imgFileUrl) {
                    throw new Error('Image file not found');
                }

                let imgFileName;
                if (downloadImage) {
                    imgFileName = sanitizeFileName(name + path.extname(imgFileUrl));
                    const imgFilePath = path.join(saveDir, imgFileName);
                    if (!fs.existsSync(imgFilePath)) {
                        const imgResponse = await fetch(imgFileUrl);
                        if (!imgResponse.ok) {
                            throw new Error('Failed load image');
                        }
                        await promisify(pipeline)(imgResponse.body, fs.createWriteStream(imgFilePath));
                    }
                } else {
                    imgFileName = imgFileUrl;
                }

                console.log(`'${name}' 예술품의 데이터를 성공적으로 가져왔습니다.`);
                resolve('('
                    + `${escape(name, 45)},`
                    + `${escape(category, 45)},`
                    + `${escape(artist, 45)},`
                    + `${escape(year, 4)},`
                    + `${escape(info.재료, 45)},`
                    + `${escape(info.규격, 45)},`
                    + `${escape(description)},`
                    + `${escape(imgFileName, 100)},`
                    + `${escape(imgFileName, 200)}`
                    + ')');
            } catch (e) {
                console.error(`'${name}' 예술품의 데이터를 가져오는 중 오류가 발생했습니다. ${e.message}`);
                resolve(null);
            }
        }));
    }
    return (await Promise.all(promises)).filter(Boolean);
}

// ['회화1', '회화2', '드로잉', '판화', '조각ㆍ설치', '사진', '공예', '디자인', '서예'];
const CATEGORY_MAP = {
    '회화1': 'WFDKO',
    '회화2': 'WFDPA',
    '드로잉': 'WFDDR',
    '판화': 'WFDPR',
    '조각ㆍ설치': 'WFDSC',
    '사진': 'WFDPH',
    '공예': 'WFDCR',
    '디자인': 'WFDDE',
    '서예': 'WFDCA'
};
const PAGE_PER_CATEGORY = 3;

const promises = [];
for (const [category, code] of Object.entries(CATEGORY_MAP)) {
    for (let i = 1; i <= PAGE_PER_CATEGORY; i++) {
        console.log(`카테고리 '${category}'의 페이지 ${i}의 데이터를 수집합니다.`);
        const url = LIST_URL
            .replace('%pageIndex', i)
            .replace('%searchWrkFieldGb', code);
        promises.push(fetchData(url));
    }
}

Promise.all(promises).then((results) => {
    const total = [];
    for (const result of results) {
        total.push(...result);
    }

    const query = INSERT_PREFIX + total.join(',\n       ') + ';';
    fs.writeFileSync(path.join(__dirname, 'insert_artwork.sql'), query);

    console.log('\n\n============================\n\n');
    console.log(`총 ${total.length}개의 데이터를 성공적으로 수집했습니다.`);
});