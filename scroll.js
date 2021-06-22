#! /usr/bin/env node

// NPM ecosystem includes
const parseArgs = require("minimist")
const glob = require("glob")
const path = require("path")
const fse = require("fs-extra")
const fs = require("fs")
const lodash = require("lodash")
const dayjs = require("dayjs")
const open = require("open")

// Tree Notation Includes
const { jtree } = require("jtree")
const { TreeNode, Utils } = jtree
const { Disk } = require("jtree/products/Disk.node.js")
const grammarNode = require("jtree/products/grammar.nodejs.js")
const stump = require("jtree/products/stump.nodejs.js")

// Helper utils
const read = filename => fs.readFileSync(filename, "utf8").replace(/\r/g, "") // Note: This also removes \r. There's never a reason to use \r.
const write = (filename, content) => fs.writeFileSync(filename, content, "utf8")
const resolvePath = (folder = "") => (folder.startsWith("/") ? folder : path.resolve(process.cwd() + "/" + folder))
const replaceAll = (str, search, replace) => str.split(search).join(replace)
const cleanAndRightShift = (str, numSpaces = 0) => str.replace(/\r/g, "").replace(/\n/g, "\n" + " ".repeat(numSpaces))
const unsafeStripHtml = html => html.replace(/<[^>]*>?/gm, "")

// Constants
const packageJson = require("./package.json")
const SCROLL_SRC_FOLDER = __dirname + "/"
const SCROLL_VERSION = packageJson.version
const SCROLL_FILE_EXTENSION = ".scroll"
const DEFAULT_PORT = 1145
const SCROLL_GRAMMAR_EXTENSION = ".grammar"
const SCROLLDOWN_GRAMMAR_FILENAME = "scrolldown.grammar"
const SCROLL_SETTINGS_FILENAME = "scroll.settings"
const EXTENSIONS_REQUIRING_REBUILD = new RegExp(`${[SCROLL_FILE_EXTENSION, SCROLL_SETTINGS_FILENAME, SCROLL_GRAMMAR_EXTENSION].join("|")}$`)

// This is all the CSS
const hakon = require("jtree/products/hakon.nodejs.js")
const SCROLL_HAKON_FILENAME = "scroll.hakon"
const SCROLL_CSS = new hakon(read(SCROLL_SRC_FOLDER + SCROLL_HAKON_FILENAME)).compile()

const CommandFnDecoratorSuffix = "Command"
const scrollBoilerplateCompiledMessage = `<!--

 This page was compiled by 📜 Scroll, the public domain
 static site publishing software.
 
 https://scroll.pub
 
 Generally you don't want to edit it by hand.

 Scroll v${SCROLL_VERSION}

-->
<!doctype html>`

const initReadmePage = `title Hello world
date ${dayjs().format(`MM-DD-YYYY`)}

paragraph
 This is my new Scroll.`

const cssClasses = {
	scrollPage: "scrollPage",
	scrollArticleCell: "scrollArticleCell",
	scrollArticleSourceLink: "scrollArticleSourceLink",
	scrollSingleArticle: "scrollSingleArticle"
}

const scrollKeywords = {
	title: "title",
	permalink: "permalink",
	paragraph: "paragraph",
	image: "image",
	date: "date",
	importFrom: "importFrom",
	skipIndexPage: "skipIndexPage"
}

const defaultSettings = {
	twitter: "",
	github: "",
	email: "",
	description: "",
	title: "",
	baseUrl: ""
}

// LinkSuffixLang. [anyWord🔗absoluteUrl] or [anyWord🔗./relativeUrl]
// anyWord text cannot contain 🔗
// url should not contain the protocol. It will compile always to https. Use <a> if you need something else.
// If url ends in a period, that will be dropped.
// Url cannot contain a comma.
const linkReplacer = (match, p1, p2, p3, offset, str) => {
	let suffix = ""
	if (p3.endsWith(",")) suffix = "," + suffix
	if (p3.endsWith(".")) suffix = "." + suffix
	p3 = p3.replace(/(,|\.)$/, "")
	let prefix = "https://"
	const isRelativeLink = p3.startsWith("./")
	if (isRelativeLink) {
		prefix = ""
		p3 = p3.substr(2)
	}
	if (p3.startsWith("https://") || p3.startsWith("http://")) prefix = ""
	return `${p1}<a href="${prefix}${p3}">${p2}</a>${suffix}`
}
const compileATags = text => text.replace(/(^|\s)(\S+)🔗(\S+)(?=(\s|$))/g, linkReplacer)
const isScrollFolder = absPath => fs.existsSync(path.normalize(absPath + "/" + SCROLL_SETTINGS_FILENAME))

const SCROLL_ICONS = new TreeNode(read(SCROLL_SRC_FOLDER + "scroll.icons")).toObject()

class Article {
	constructor(scrolldownProgram, filename = "", sourceLink = "") {
		this.scrolldownProgram = scrolldownProgram
		this.sourceLink = sourceLink
		this.filename = filename
	}

	sourceLink = ""
	filename = ""

	get permalink() {
		return this.scrolldownProgram.get(scrollKeywords.permalink) || this.filename.replace(/\.scroll$/, "")
	}

	get ogImage() {
		// my goodness the jtree API is bad. how do I get the first value of "image"?
		return (
			this.scrolldownProgram
				.clone()
				.reverse()
				.get(scrollKeywords.image) ?? ""
		)
	}

	// Use the first paragraph for the description
	get ogDescription() {
		const node = this.scrolldownProgram
			.clone()
			.reverse()
			.getNode(scrollKeywords.paragraph)
		return node
			? unsafeStripHtml(node.compile())
					.replace(/\n/g, " ")
					.substr(0, 300)
			: ""
	}

	get includeInIndex() {
		return !this.scrolldownProgram.has(scrollKeywords.skipIndexPage)
	}

	get title() {
		return this.scrolldownProgram.get(scrollKeywords.title) ?? ""
	}

	get timestamp() {
		return dayjs(this.scrolldownProgram.get(scrollKeywords.date) ?? 0).unix()
	}

	get htmlCode() {
		const sourceLink = this.sourceLink ? `<p class="${cssClasses.scrollArticleSourceLink}"><a href="${this.sourceLink}">Article source</a></p>` : ""

		const program = this.scrolldownProgram
		program.setPermalink(this.permalink)
		return program.compile() + sourceLink
	}
}

class RssImporter {
	constructor(path) {
		this.path = path
	}
	path = ""

	savePost(item, content, destinationFolder) {
		const { title, pubDate, isoDate } = item
		const date = pubDate || isoDate ? `date ${pubDate || isoDate}` : ""
		const scrollFile = `title ${title}
${date}
paragraph
 ${cleanAndRightShift(content, 1)}
`
		write(destinationFolder + "/" + Utils.stringToPermalink(title) + ".scroll", scrollFile)
	}

	async downloadFilesTo(destinationFolder) {
		const Parser = require("rss-parser")
		const got = require("got")
		const cheerio = require("cheerio")

		const parser = new Parser()

		console.log(`⏳ downloading '${this.path}'`)
		const feed = await parser.parseURL(this.path)

		await Promise.all(
			feed.items.map(async item => {
				if (item.content) return this.savePost(item, item.content, destinationFolder)

				try {
					console.log(`⏳ downloading '${item.link}'`)
					const response = await got(item.link)
					const html = response.body
					const dom = cheerio.load(html)
					this.savePost(item, dom.text(), destinationFolder)
				} catch (err) {
					console.log(`❌ downloading '${item.link}'`)
				}
			})
		)
	}
}

class AbstractScrollPage {
	constructor(scroll) {
		this.scroll = scroll
	}

	get scrollSettings() {
		return this.scroll.settings
	}

	get articles() {
		return this.scroll.publishedArticles.filter(article => article.includeInIndex)
	}

	get htmlTitle() {
		return this.scrollSettings.title
	}

	get description() {
		return this.scrollSettings.description
	}

	get github() {
		return this.scrollSettings.github
	}

	get email() {
		return this.scrollSettings.email
	}

	get twitter() {
		return this.scrollSettings.twitter
	}

	get baseUrl() {
		return this.scrollSettings.baseUrl ?? ""
	}

	get header() {
		const customHeader = this.scroll.settingsTree.getNode("header")
		if (customHeader) return customHeader.childrenToString()
		return `div
 class scrollHeader
 div
  class scrollTopRightBar
  div
   class scrollSocialMediaIcons
   a ${SCROLL_ICONS.githubSvg}
    href ${this.github}
 h2
  class scrollTitle
  a ${this.scrollSettings.title}
   href index.html
 div ${this.description}
  class scrollDescription`
	}

	get footer() {
		const customFooter = this.scroll.settingsTree.getNode("footer")
		if (customFooter) return customFooter.childrenToString()
		return `div
 class scrollFooter
 div
  class scrollSocialMediaIcons
  a ${SCROLL_ICONS.emailSvg}
   href mailto:${this.email}
  a ${SCROLL_ICONS.twitterSvg}
   href ${this.twitter}
  a ${SCROLL_ICONS.githubSvg}
   href ${this.github}
 a Built with Scroll v${SCROLL_VERSION}
  href https://scroll.pub
  class scrollCommunityLink`
	}

	get stumpCode() {
		return `html
 lang en-US
 head
  meta
   charset utf-8
  titleTag ${this.htmlTitle}
  meta
   name viewport
   content width=device-width,initial-scale=1
  meta
   name description
   content ${this.description}
  meta
   name generator
   content Scroll v${SCROLL_VERSION}
  meta
   property og:title
   content ${this.ogTitle}
  meta
   property og:description
   content ${this.ogDescription}
  meta
   property og:image
   content ${this.ogImage ? this.baseUrl + this.ogImage : ""}
  meta
   name twitter:card
   content summary_large_image
  styleTag
   bern
    ${cleanAndRightShift(SCROLL_CSS, 4)}
 body
  ${cleanAndRightShift(this.header, 2)}
  ${cleanAndRightShift(this.pageCode, 2)}
  ${cleanAndRightShift(this.footer, 2)}`
	}

	get pageCode() {
		const articles = this.articles
			.map(article => {
				const node = new TreeNode(`div
 class ${cssClasses.scrollArticleCell}`)
				node.getNode("div").appendLineAndChildren("bern", article.htmlCode)
				return node.toString()
			})
			.join("\n")

		return `div
 class ${cssClasses.scrollPage}
 ${cleanAndRightShift(articles, 1)}`
	}

	get ogTitle() {
		return this.scrollSettings.title
	}

	get ogDescription() {
		return this.description
	}

	get ogImage() {
		return ""
	}

	toHtml() {
		return scrollBoilerplateCompiledMessage + "\n" + new stump(this.stumpCode).compile()
	}
}

class ScrollArticlePage extends AbstractScrollPage {
	constructor(scroll, article) {
		super(scroll)
		this.article = article
	}

	get ogDescription() {
		return this.article.ogDescription
	}

	get ogImage() {
		return this.article.ogImage
	}

	get ogTitle() {
		return this.article.title
	}

	get htmlTitle() {
		const { title } = this.article
		return (title ? `${title} - ` : "") + this.scrollSettings.title
	}

	get pageCode() {
		return `div
 class ${cssClasses.scrollPage} ${cssClasses.scrollSingleArticle}
 style ${this.cssColumnWorkaround}
 bern
  ${cleanAndRightShift(this.article.htmlCode, 2)}`
	}

	get cssColumnWorkaround() {
		const estimatedLines = lodash.sum(this.article.scrolldownProgram.map(node => (node.getNodeTypeId() === "blankLineNode" ? 0 : node.getTopDownArray().length)))
		if (estimatedLines > 20) return ""
		const maxColumns = estimatedLines > 10 ? 2 : 1
		const width = maxColumns * 40

		return `column-count:${maxColumns};max-width:${width}ch;`
	}
}

class ScrollIndexPage extends AbstractScrollPage {}

const compilerCache = new Map()
const getCompiler = filePaths => {
	const key = filePaths.join("\n")
	const hit = compilerCache.get(key)
	if (hit) return hit
	const compiler = new jtree.HandGrammarProgram(filePaths.map(file => read(file)).join("\n")).compileAndReturnRootConstructor()
	compilerCache.set(key, compiler)
	return compiler
}

class ScrollFolder {
	constructor(scrollFolder = __dirname) {
		this.scrollFolder = path.normalize(scrollFolder + "/")
		const grammarFiles = Disk.getFiles(this.scrollFolder).filter(filename => filename.endsWith(SCROLL_GRAMMAR_EXTENSION) && !filename.endsWith(SCROLLDOWN_GRAMMAR_FILENAME))
		grammarFiles.unshift(`${__dirname}/${SCROLLDOWN_GRAMMAR_FILENAME}`)
		this.grammarFiles = grammarFiles
	}

	grammarFiles = []

	get scrolldownCompiler() {
		return getCompiler(this.grammarFiles)
	}

	get grammarErrors() {
		return new grammarNode(this.grammarFiles.map(file => read(file)).join("\n")).getAllErrors().map(err => err.toObject())
	}

	get publishedArticles() {
		const { gitLink, scrolldownCompiler, scrollFolder } = this
		const all = Disk.getFiles(scrollFolder)
			.filter(file => file.endsWith(SCROLL_FILE_EXTENSION))
			.map(filename => new Article(new scrolldownCompiler(read(filename)), path.basename(filename), gitLink ? gitLink + path.basename(filename) : ""))
		return lodash.sortBy(all, article => article.timestamp).reverse()
	}

	get gitLink() {
		return this.settings.git + "/"
	}

	get errors() {
		return this.publishedArticles
			.map(article =>
				article.scrolldownProgram.getAllErrors().map(err => {
					return { filename: article.filename, ...err.toObject() }
				})
			)
			.flat()
	}

	get settings() {
		return { ...defaultSettings, ...this.settingsTree.toObject() }
	}

	get settingsTree() {
		return new TreeNode(read(this.scrollFolder + "/" + SCROLL_SETTINGS_FILENAME))
	}

	silence() {
		this.verbose = false
		return this
	}

	verbose = true
	scrollFolder = ""

	get settingsPath() {
		return this.scrollFolder + SCROLL_SETTINGS_FILENAME
	}

	get indexPage() {
		return new ScrollIndexPage(this)
	}

	log(message) {
		if (this.verbose) console.log(message)
		return message
	}

	previousVersion = ""

	singlePages = new Map()
	writeSinglePages() {
		const settings = this.settings
		return this.publishedArticles.map(article => {
			const permalink = `${article.permalink}.html`
			const html = new ScrollArticlePage(this, article).toHtml()
			if (this.singlePages.get(permalink) === html) return "Unmodified"
			write(`${this.scrollFolder}/${permalink}`, html)
			this.singlePages.set(permalink, html)
			this.log(`Wrote ${permalink} to disk`)
			return { permalink, html }
		})
	}

	buildIndexPage() {
		const html = this.indexPage.toHtml()
		if (this.previousVersion !== html) {
			const start = Date.now()
			write(this.scrollFolder + "/index.html", html)
			this.previousVersion = html
			this.log(`Built and wrote new index.html to disk in ${(Date.now() - start) / 1000} seconds`)
		}
		return html
	}

	// rss, twitter, hn, reddit, pinterest, instagram, tiktok, youtube?
	async importSite() {
		const { importFrom } = this

		if (!importFrom) return `❌ You need to add a line to '${this.settingsPath}' like '${scrollKeywords.importFrom}'`

		// A loose check for now to catch things like "format=rss"
		if (importFrom.includes("rss") || importFrom.includes("feed")) {
			const importer = new RssImporter(importFrom)
			return await importer.downloadFilesTo(this.scrollFolder)
		}

		return `❌ Scroll wasn't sure how to import '${importFrom}'.\n💡 You can open an issue here: https://github.com/publicdomaincompany/scroll/issues`
	}

	get importFrom() {
		return this.settings.importFrom
	}

	buildPages() {
		const start = Date.now()
		const pages = this.writeSinglePages()
		this.log(`⌛️ built ${pages.length} html files in ${(Date.now() - start) / 1000} seconds`)
	}

	get localIndexAsUrl() {
		return `file://${this.scrollFolder}/index.html`
	}

	async openBrowser() {
		await open(this.localIndexAsUrl)
	}

	watcher = undefined
	startWatching() {
		const { scrollFolder } = this

		this.log(`\n🔭 Watching for changes in 📁 ${scrollFolder}`)

		this.watcher = fs.watch(scrollFolder, (event, filename) => {
			const fullPath = scrollFolder + filename
			if (!EXTENSIONS_REQUIRING_REBUILD.test(fullPath)) return

			if (!Disk.exists(fullPath)) {
				// file deleted
			} else if (false) {
				// new file
			} else {
				// file updates
			}
			this.buildIndexPage()
			this.buildPages()
		})
	}

	stopWatchingForFileChanges() {
		this.watcher.close()
		delete this.watcher
	}
}

class ScrollCli {
	execute(args = []) {
		this.log(`\n📜📜📜 WELCOME TO SCROLL (v${SCROLL_VERSION}) 📜📜📜`)
		const command = args[0] // Note: we don't take any parameters on purpose. Simpler UX.
		const commandName = `${command}${CommandFnDecoratorSuffix}`
		const cwd = process.cwd()
		if (this[commandName]) return this[commandName](cwd)

		this.log(`No command provided. Running help command.`)
		return this.helpCommand()
	}

	verbose = true
	log(message) {
		if (this.verbose) console.log(message)
		return message
	}

	get _allCommands() {
		return Object.getOwnPropertyNames(Object.getPrototypeOf(this))
			.filter(word => word.endsWith(CommandFnDecoratorSuffix))
			.sort()
	}

	async initCommand(cwd) {
		const folder = new ScrollFolder()
		if (isScrollFolder(cwd)) return this.log(`❌ Initialization aborted. Folder '${cwd}' already contains a '${SCROLL_SETTINGS_FILENAME}'.`)
		this.log(`Initializing scroll in "${cwd}"`)
		write(cwd + "/" + SCROLL_SETTINGS_FILENAME, read(__dirname + "/" + SCROLL_SETTINGS_FILENAME))
		const readmePath = cwd + "/readme.scroll"
		if (!fs.existsSync(readmePath)) write(readmePath, initReadmePage)
		return this.log(`\n👍 Initialized new scroll in '${cwd}'. Build your new site with: scroll build`)
	}

	deleteCommand() {
		return this.log(`\n💡 To delete a Scroll just delete the folder\n`)
	}

	async importCommand(cwd) {
		const fullPath = resolvePath(cwd)
		if (!isScrollFolder(fullPath)) return this.log(`❌ Folder '${cwd}' has no '${SCROLL_SETTINGS_FILENAME}' file.`)

		const folder = new ScrollFolder(cwd)
		const result = await folder.importSite()
		return this.log(result)
	}

	checkCommand(cwd) {
		const fullPath = resolvePath(cwd)
		if (!isScrollFolder(fullPath)) return this.log(`❌ Folder '${cwd}' has no '${SCROLL_SETTINGS_FILENAME}' file.`)
		const folder = new ScrollFolder(fullPath)
		const { grammarErrors } = folder
		const grammarMessage = grammarErrors.length ? new jtree.TreeNode(grammarErrors).toFormattedTable(200) + "\n" : ""
		if (grammarMessage) this.log(grammarMessage)
		const scrollErrors = folder.errors
		const message = scrollErrors.length ? new jtree.TreeNode(scrollErrors).toFormattedTable(60) : "0 errors"
		return this.log(message)
	}

	async buildCommand(cwd) {
		const fullPath = resolvePath(cwd)
		if (!isScrollFolder(fullPath)) return this.log(`❌ Folder '${cwd}' has no '${SCROLL_SETTINGS_FILENAME}' file.`)

		const folder = new ScrollFolder(fullPath)
		folder.verbose = this.verbose
		folder.buildIndexPage()
		folder.writeSinglePages()
		return folder
	}

	async watchCommand(cwd) {
		const folder = await this.buildCommand(cwd)
		if (!folder.startWatching) return
		folder.startWatching()
		folder.openBrowser()
		return folder
	}

	helpCommand() {
		return this.log(`\nThis is the Scroll help page.\n\nCommands you can run from your Scroll's folder:\n\n${this._allCommands.map(comm => `🖌️ ` + comm.replace(CommandFnDecoratorSuffix, "")).join("\n")}\n​​`)
	}
}

if (module && !module.parent) new ScrollCli().execute(parseArgs(process.argv.slice(2))._)

module.exports = { ScrollFolder, ScrollCli, SCROLL_SETTINGS_FILENAME, compileATags, scrollKeywords }
