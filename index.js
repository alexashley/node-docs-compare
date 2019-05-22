const fetch = require('node-fetch');
const cheerio = require('cheerio');
const assert = require('assert');
const fs = require('fs');

const mkdir = (dir) => {
    if (fs.existsSync(dir)) {
        return;
    }

    fs.mkdirSync(dir, {
        recursive: true
    });
};

const get = async (uri) => {
    const response = await fetch(uri);
    const responseText = await response.text();

    if (!response.ok) {

        throw new Error(`Non-2xx response: ${response.status}. response body: ${responseText}`);
    }

    return responseText;
};

const getJson = async (uri) => {
    const text = await get(uri);

    return JSON.parse(text);
};

const fetchModuleList = async (majorVersion) => {
    const synopsisUri = `https://nodejs.org/docs/latest-v${majorVersion}.x/api/synopsis.html`;
    const synopsisPage = await get(synopsisUri);
    const document = cheerio.load(synopsisPage);

    const moduleList = document('ul')[1]; // very fragile, but there's no class or id. Also no surrounding element with a better selector.

    return moduleList.children
        .filter((elem) => elem.type === 'tag' && elem.name === 'li')
        .map((elem) => elem.children[0].attribs.href)
        .map((moduleHtmlLink) => moduleHtmlLink.split('.')[0]);
};

const flatten = (a) => a.reduce((acc, curr) => {
    return Array.isArray(curr) ? [...acc, ...flatten(curr)] : [...acc, curr]
}, []);

const createMethod = (m) => {
    assert.strictEqual(m.signatures.length, 1, `Found more signatures than expected for ${m.textRaw}: ${JSON.stringify(m)}`);

    const returnValue = m.signatures[0]['return'] && m.signatures[0]['return'].type;

    return {
        name: m.name,
        signature: m.textRaw,
        returnType: returnValue || null,
    };
};

const getModuleDefinition = async (moduleName, majorVersion) => {
    const cachedFilePath = `./cache/${majorVersion}/${moduleName}.json`;
    if (fs.existsSync(cachedFilePath)) {
        return JSON.parse(fs.readFileSync(cachedFilePath).toString('utf-8'));
    }

    const moduleUri = `https://nodejs.org/docs/latest-v${majorVersion}.x/api/${moduleName}.json`;
    const module = await getJson(moduleUri);

    fs.writeFileSync(cachedFilePath, JSON.stringify(module));

    return module;
};

const createModuleForVersion = async (moduleName, majorVersion, moduleMetadata) => {
    if (!moduleMetadata) {
        const topLevelModule = await getModuleDefinition(moduleName, majorVersion);

        if (!topLevelModule.modules) { // special case for C++ addons module
            return null;
        }

        assert.strictEqual(topLevelModule.modules.length, 1, `${moduleName} should have one top level module`);

        moduleMetadata = topLevelModule.modules[0];
    }

    let methods = [];
    let classes = [];
    let modules = [];

    if (moduleMetadata.methods) {
        methods = moduleMetadata.methods.map((m) => {
            return createMethod(m);
        });
    }

    if (moduleMetadata.classes) {
        classes = moduleMetadata.classes
            .filter((c) => c.methods) // has methods
            .map((c) => {
                const methods = c.methods.map((m) => createMethod(m));

                return {
                    methods,
                    name: c.name
                }
            })
    }

    if (moduleMetadata.modules) {
        modules = await Promise.all(moduleMetadata.modules.map(async (m) => {
            try {
                return await createModuleForVersion(m.name, majorVersion, m);
            } catch (e) {
                console.error('recurisve module expansion error', e);
                return null;
            }
        }));
    }

    return {
        name: moduleMetadata.name,
        methods: flatten([methods, modules.map(m => m.methods)]),
        classes: flatten([classes, modules.map(m => m.classes)])
    };
};

const pad = (str, paddingLength = 24) => `${str}${Array(paddingLength - str.length).fill(' ').join('')}`;

(async () => {
    const [, , olderVersion, newerVersion] = process.argv;

    if (!(olderVersion && newerVersion)) {
        console.error(`Missing version arguments. Sample use: node index.js 10 12`);
        process.exit(1);
    }

    if (!(Number(olderVersion) && Number(newerVersion))) {
        console.error('Must use numbers as arguments. Sample use: node index.js 10 12');
        process.exit(1);
    }

    // console.log(`comparing documentation between ${olderVersion} and ${newerVersion}`);

    try {
        mkdir(`./cache/${olderVersion}`);
        mkdir(`./cache/${newerVersion}`);

        const oldModuleList = await fetchModuleList(olderVersion);
        const oldModules = [];
        for (let i = 0; i < oldModuleList.length; i++) {
            const m = await createModuleForVersion(oldModuleList[i], olderVersion);

            if (m) {
                oldModules.push(m);
            }
        }

        const newModuleList = await fetchModuleList(newerVersion);
        const newModules = [];
        for (let i = 0; i < newModuleList.length; i++) {
            const m = await createModuleForVersion(newModuleList[i], newerVersion);

            if (m) {
                newModules.push(m);
            }
        }

        oldModules.forEach((oldModule) => {
            const newModule = newModules.find((m) => m.name === oldModule.name);

            const oldModuleMethodNames = oldModule.methods.map((m) => m.name);
            const newMethods = newModule.methods.filter((m) => !oldModuleMethodNames.includes(m.name));

            if (newMethods.length) {
                console.log(`${pad(newModule.name)} ${newMethods.length} new`);

                newMethods.forEach((m) => {
                    console.log(`- ${m.name}: ${m.returnType}`)
                });
            }
        });
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();