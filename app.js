// Declare variables
const express = require('express')
const path = require('path');
const cookieParser = require("cookie-parser");
const sessions = require('express-session');
const bodyParser = require('body-parser')
const mysql = require("pg");
const credentials = require('./config/credentials');
const app = express()
var hbs = require('express-handlebars');
const formidable = require('formidable')
const fs = require('fs');
const util = require('util');
const CryptoJS = require('./assets/scripts/aes-256.js')
const port = process.env.PORT || 3000
const { Client } = require('pg');
const AWS = require('aws-sdk');
var s3 = new AWS.S3();
const { Pool } = require('pg')

const pgSession = require('connect-pg-simple')(sessions);
var log4js = require("log4js");
var logger = log4js.getLogger();

// Setup bodyparser and cookieparser
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/assets')));

// Setup HandleBars
app.set('view engine', '.hbs');
app.set('views', path.join(__dirname, 'views'));

// Setup helpers
app.engine('.hbs', hbs.engine({
    defaultLayout: 'index',
    extname: '.hbs',
    helpers: {
        section: function (name, options) {
            if (!this._sections) this._sections = {};
            this._sections[name] = options.fn(this);
            return null;
        },
        testCond: function (v1, v2, options) {
            if (v1 === v2) {
                return options.fn(this);
            }
            return options.inverse(this);
        },
        testOpos: function (v1, v2, options) {
            if (v1 !== v2) {
                return options.fn(this);
            }
            return options.inverse(this);
        }
    },
    partialsDir: __dirname + '/views/partials/'
}));

let config = new AWS.Config({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey
});

class EnhancedClient extends Client {
    getStartupConf() {
        if (credentials.pgOption) {
            try {
                console.log(credentials.pgOption)
                const options = JSON.parse(credentials.pgOption);
                console.log(options)
                return {
                    ...super.getStartupConf(),
                    ...options,
                };
            } catch (e) {
                console.error(e);
                // Coalesce to super.getStartupConf() on parse error
            }
        }

        return super.getStartupConf();
    }
}

const pool = new Pool({
    Client: EnhancedClient,
    user: credentials.user,
    host: credentials.host,
    database: 'blog',
    password: credentials.password,
    port: 5432
})
const postgreStore = new pgSession({
    pool: pool,
    createTableIfMissing: true,
})
// Setup session for one day 
const oneDay = 1000 * 60 * 60 * 24;
app.use(sessions({
    store: postgreStore,
    secret: "19a4bf3706d0b9f0361444a675736717",
    saveUninitialized: true,
    cookie: { maxAge: oneDay },
    resave: false,

}));




// Declate help query 
const query = () => {

}

// Receive post with registration
app.post('/register', (req, res) => {
    // Declare fast variables
    let firstName = req.body.firstName
    let lastName = req.body.lastName
    let email = req.body.email
    let birthday = req.body.birthday
    let password = req.body.password
    password = CryptoJS.AES.decrypt(password, email).toString(CryptoJS.enc.Utf8);

    // Check again password policy
    let policy = checkPasswordPolicy(password)
    if (!policy.pass) res.end(JSON.stringify(policy))

    // Get all emails from databse
    let emails = pool.query("SELECT Email FROM users;", (err, result) => {
        if (err) res.end(JSON.stringify({ accountCreated: false, errorMessage: "Internal server error" }));

        //Check if email exist in databse
        let bool = true
        result.rows.forEach((item) => { if (item.Email == email) bool = false })
        if (!bool) res.end(JSON.stringify({ accountCreated: false, errorMessage: "This email exist in database" }))

        // Check If everything is correct
        if (bool && firstName !== undefined && lastName !== undefined && email !== undefined && birthday !== undefined && password !== undefined) {
            if (firstName !== "" && lastName !== "" && email !== "", birthday !== "" && password !== "") {

                // Encrypt password with eas-256 alghoritm from google, key to encryption = email
                password = CryptoJS.AES.encrypt(password, email).toString()

                // Send query with new user to database
                let query = pool.query("INSERT INTO users (FirstName, LastName, Email, BirthDay, Password) VALUES ('" + firstName + "', '" + lastName + "', '" + email + "', '" + birthday + "', '" + password + "');", (err, result) => {
                    // Check if query was successful
                    if (err) res.end(JSON.stringify({ accountCreated: false, errorMessage: err }));
                    if (result) {
                        // Return success
                        logger.info("Account created")
                        req.session.email = email
                        req.session.logged = true
                        res.end(JSON.stringify({ accountCreated: true }));

                    }
                })
            } else {
                res.end(JSON.stringify({ accountCreated: false, errorMessage: "Empty record" }))

            }
        } else {
            res.end(JSON.stringify({ accountCreated: false, errorMessage: "Invalid arguments" }))
        }
    })

})
// Password policy (min 8 characters and not more than 20, min one special character in password)
function checkPasswordPolicy(passwd) {
    if (passwd.length < 8) return { pass: false, errorMessage: "Password must be at least 8 characters" }
    if (passwd.length > 20) return { pass: false, errorMessage: "Password must have less than 20 characters" }
    if (!(passwd.includes("*") || passwd.includes("!") || passwd.includes("@") || passwd.includes("#") || passwd.includes("$") || passwd.includes("%") || passwd.includes("^") || passwd.includes("*") || passwd.includes("&"))) return { pass: false, errorMessage: "Password must have at least one character (!,@,#,$,%,^,&,*)" }
    else return { pass: true }
}

// Handle login Post 
app.post("/login", (req, res) => {

    // Check if data exist
    if (req.body.password !== undefined && req.body.email !== undefined) {
        let email = req.body.email
        let password = req.body.password

        // Decrypt password from site
        password = CryptoJS.AES.decrypt(password, email).toString(CryptoJS.enc.Utf8);
        logger.info("Logowanie")
        // Retrieves the password record where the email is
        let conn = pool.query("SELECT email,password FROM users WHERE email = '" + email + "'", (err, result) => {
            // Check if email exist in database and record is not null
            if (err) res.end(JSON.stringify({ logged: false, errorMessage: "Email or password is incorrect!", err: err }));
            if (result.rows.length > 0 && result.rows[0].email == email) {

                // Decrypt password from database
                let decryptedPasswd = CryptoJS.AES.decrypt(result.rows[0].password, email).toString(CryptoJS.enc.Utf8);

                // Check if passwords matches, when success create session and return success message
                if (decryptedPasswd == password) {
                    req.session.email = email
                    req.session.logged = true

                    res.end(JSON.stringify({ logged: true }));
                } else {
                    res.end(JSON.stringify({ logged: false, errorMessage: "Email or password is incorrect2!" }));
                }
            } else res.end(JSON.stringify({ logged: false, errorMessage: "Email or password is incorrect1!" }));
        })
    } else {
        res.end(JSON.stringify({ logged: false, errorMessage: "Email or password is incorrect!" }));
    }
})

// Handle creation blog request
app.post("/createpost", async (req, res) => {
    // Check if logged
    if (!req.session.logged) res.render("nopermissions.hbs")

    // Parse request with formidable
    const form = new formidable.IncomingForm();
    form.keepExtensions = true;
    form.multiples = true

    // Create worked array for parsing request
    let blog = { blog: [], title: '', thumbnail: '' }


    form.parse(req, async function (err, fields, files) {
        if (err) { logger.info(err); return }

        // Set title and public status 
        blog["public"] = fields["public"]
        blog["title"] = fields["title"]

        // Check if thumbnail exists
        if (files["thumbnail"] !== undefined) {
            let thumbnail = files["thumbnail"]
            let hash = makeid(20)
            let allhashes = pool.query(`SELECT filename FROM filenames WHERE filename = '${hash}'`, (err, result) => {
                while (result.rows.length > 0) {
                    hash = makeid(20)
                    allhashes = pool.query(`SELECT filename FROM filenames WHERE filename = '${hash}'`)
                }


                let parsed = thumbnail.originalFilename.split('.')
                let extension = parsed[parsed.length - 1]

                // Change temp file save to new location inside uploads folder
                var oldPath = thumbnail.filepath;

                let bucket = {
                    Bucket: credentials.awsbucketID,
                    Body: fs.createReadStream(oldPath),
                    Key: `${credentials.awsPath}/thumbnail/${hash}.${extension}`
                }
                s3.upload(bucket, function (err, data) {
                    //handle error
                    if (err) {
                        logger.info("Error", err);
                    }

                    //success
                    if (data) {
                        logger.info("Uploaded in:", data.Location);
                    }
                });
                blog["thumbnail"] = hash + "." + extension
            })
        }

        // Handle created blog request, for each section
        for (x in Object.entries(fields)) {

            if (fields[x] !== undefined) {

                // Single section 
                let row = JSON.parse(fields[x])
                if (row.type !== "text") {

                    // If type == Video, Audio, Image get assigned file
                    let type = files[row.file].mimetype.split('/')[0]
                    let file = files[row.file]
                    let parsed = file.originalFilename.split('.')
                    let extension = parsed[parsed.length - 1]
                    let hash = makeid(20)

                    // Save assigned file to new location
                    var oldPath = file.filepath;

                    let bucket = {
                        Bucket: credentials.awsbucketID,
                        Body: fs.createReadStream(oldPath),
                        Key: `${credentials.awsPath}/${type}/${hash}.${extension}`
                    }
                    s3.upload(bucket, function (err, data) {
                        //handle error
                        if (err) {
                            logger.info("Error", err);
                        }

                        //success
                        if (data) {
                            logger.info("Uploaded in:", data.Location);
                        }
                    });

                    // Append parsed row to array
                    blog.blog.push({ type: row.type, size: row.size, file: hash + "." + extension, order: x })

                } else {
                    blog.blog.push({ type: row.type, text: row.value, order: x })
                }
            }
        }

        let resut = await handleDatabaseCreateBlog(req, blog)
        res.end(JSON.stringify(resut))
    })
})

// Query all data to database
async function handleDatabaseCreateBlog(req, blog) {

    // Get id of user 
    let ID = await pool.query(`SELECT ID FROM users WHERE email = '${req.session.email}';`)
    // if (ID.rows.length !== 1) return { success: false }
    let title = blog.title.split('"')[1]
    // First append data to bloglist table with core information
    let appendToBlogList = await pool.query(`INSERT INTO bloglist (title, thumbnail, createdby, public) VALUES ('${title}', '${blog.thumbnail}', ${ID.rows[0].id}, '${blog.public}');`, (err, result) => {

    })

    // Get id from successful query
    let IDofBlog = await pool.query(`SELECT id FROM bloglist WHERE title = '${title}' AND thumbnail = '${blog.thumbnail}'`)
    IDofBlog = IDofBlog.rows[0].id
    let order = 0

    // Secondly append all section to blogcontent and linked files to filenames table
    for (p of blog.blog) {
        if (p.type !== 'text') {
            let file = p.file.split('.')

            let fileContent = await pool.query(`INSERT INTO filenames (filename, extension, size) VALUES ('${file[0]}', '${file[1]}', '${p.size}');`)

            let fileContentID = await pool.query(`SELECT id FROM filenames WHERE filename = '${file[0]}';`)
            fileContentID = fileContentID.rows[0].id


            let blogContent = await pool.query(`INSERT INTO blogcontent (blogID, type, text, orderOf, fileID) VALUES ('${IDofBlog}', '${p.type}', NULL, '${order}', '${fileContentID}')`)
        } else {
            let blogContent = await pool.query(`INSERT INTO blogcontent (blogID, type, text, orderOf, fileID) VALUES ('${IDofBlog}', '${p.type}', '${p.text}', '${order}', NULL)`)
        }
        order++
    }

    // return success
    return { succes: true }
}

// Handle logout by destrong session
app.get('/logout', (req, res) => {
    req.session.logged = false
    req.session.email = undefined
    res.redirect("/")
})

// Get which handle main site of blog
app.get('/', async (req, res) => {

    // Get all poblic posts with their sections
    let posts = await pool.query("SELECT users.FirstName,users.LastName, bloglist.ID, bloglist.public, bloglist.title, bloglist.thumbnail, bloglist.createdby, blogcontent.type, blogcontent.text, blogcontent.orderOf, filenames.filename, filenames.extension from blogcontent INNER JOIN bloglist ON blogcontent.blogID = bloglist.ID LEFT JOIN filenames ON filenames.ID = blogcontent.fileID INNER JOIN users ON bloglist.createdby = users.ID WHERE bloglist.public = 'true';")
    let publicPosts = createDataFromDatabse(posts)

    // Get all private posts with their sections
    let privatePosts
    if (req.session.email !== undefined && req.session.logged) {
        logger.info("Premium user")
        let posts2 = await pool.query("SELECT users.FirstName,users.LastName, bloglist.ID, bloglist.public, bloglist.title, bloglist.thumbnail, bloglist.createdby, blogcontent.type, blogcontent.text, blogcontent.orderOf, filenames.filename, filenames.extension from blogcontent INNER JOIN bloglist ON blogcontent.blogID = bloglist.ID LEFT JOIN filenames ON filenames.ID = blogcontent.fileID INNER JOIN users ON bloglist.createdby = users.ID WHERE bloglist.public = 'false';")
        privatePosts = createDataFromDatabse(posts2)
    }

    // Return all to users
    res.render('mainPage.hbs', { logged: (!req.session.logged) ? false : true, publicBlogs: publicPosts, privateBlogs: privatePosts })
})

// Get single blog quered by nameOfBlog-ID
app.get("/blog/:blogTitle", async (req, res) => {

    // Parse request href
    let title = req.params.blogTitle.split("_").join(" ")
    let titleParsed = title.split("-")

    let idCon = req.params.blogTitle.split("-")
    let id = idCon[idCon.length - 1]
    logger.info('ERROR PRZED', title, id, `SELECT  users.FirstName,users.LastName, bloglist.ID, bloglist.public, bloglist.title, bloglist.thumbnail, bloglist.createdby, blogcontent.type, blogcontent.text, blogcontent.orderOf, filenames.filename, filenames.extension, filenames.size from blogcontent INNER JOIN bloglist ON blogcontent.blogID = bloglist.ID LEFT JOIN filenames ON filenames.ID = blogcontent.fileID INNER JOIN users ON bloglist.createdby = users.ID WHERE bloglist.title = '${titleParsed[0]}' AND bloglist.ID = '${id}';`)
    // Get blog from databse
    let blog = await pool.query(`SELECT  users.FirstName,users.LastName, bloglist.ID, bloglist.public, bloglist.title, bloglist.thumbnail, bloglist.createdby, blogcontent.type, blogcontent.text, blogcontent.orderOf, filenames.filename, filenames.extension, filenames.size from blogcontent INNER JOIN bloglist ON blogcontent.blogID = bloglist.ID LEFT JOIN filenames ON filenames.ID = blogcontent.fileID INNER JOIN users ON bloglist.createdby = users.ID WHERE bloglist.title = '${titleParsed[0]}' AND bloglist.ID = '${id}';`)
    logger.info('ERROR PO')

    // Check if blog exists and return response to user, also handling session with private blogs
    if (blog.length == 0) res.render("error.hbs", { logged: (!req.session.logged) ? false : true })
    else {
        let publicPosts = createDataFromDatabse(blog)
        if (publicPosts[0].public == 'false' && (req.session.logged == undefined || !req.session.logged)) res.render("nopermissions.hbs")
        else res.render("bigblog.hbs", { blog: publicPosts[0], logged: (!req.session.logged) ? false : true })
    }
})
// Get single file
app.get("/uploads/:folder/:filename", async (req, res) => {
    let onlyFileName = req.params.filename.split(".")

    // Check if file was in public area
    logger.info("TU")
    let public = await pool.query(`SELECT bloglist.public FROM filenames INNER JOIN blogcontent ON blogcontent.fileID = filenames.ID INNER JOIN bloglist ON  blogcontent.blogID = bloglist.ID WHERE filenames.filename = '${onlyFileName[0]}'`)
    logger.info("TU2")

    let publicThumbnail = await pool.query(`SELECT public FROM bloglist WHERE thumbnail = '${req.params.filename}'`)

    // Send thumbnail
    params = {
        Bucket: credentials.awsbucketID,
        Key: `${credentials.awsPath}/${req.params.folder}/${req.params.filename}`
    }
    if (req.params.folder == "thumbnail" && publicThumbnail.rows.length > 0) {
        if (!(publicThumbnail.rows[0].public == "true") && req.session.logged) {
            s3.getObject(params, function (err, data) {
                if (err) {
                    logger.info(err);
                } else {
                    logger.info("Successfully dowloaded data from  bucket");
                    res.attachment(params.Key); // Set Filename
                    res.type(data.ContentType); // Set FileType
                    res.send(data.Body);        // Send File Buffer
                }
            });
        }
        else if (publicThumbnail.rows[0].public == "true") {
            s3.getObject(params, function (err, data) {
                if (err) {
                    logger.info(err)
                } else {
                    logger.info("Successfully dowloaded data from  bucket");
                    res.attachment(params.Key); // Set Filename
                    res.type(data.ContentType); // Set FileType
                    res.send(data.Body);        // Send File Buffer
                }
            });
        }
        else res.end(JSON.stringify({ error: true }))
    }

    // Return file to user
    if (public.rows.length > 0 && req.params.folder !== "thumbnail") {
        if (!(public.rows[0].public == "true") && req.session.logged) {
            s3.getObject(params, function (err, data) {
                if (err) {
                    logger.info(err)
                } else {
                    logger.info("Successfully dowloaded data from  bucket");
                    res.attachment(params.Key); // Set Filename
                    res.type(data.ContentType); // Set FileType
                    res.send(data.Body);        // Send File Buffer
                }
            });
        }
        else if (public.rows[0].public == "true") {
            s3.getObject(params, function (err, data) {
                if (err) {
                    logger.info(err)
                } else {
                    logger.info("Successfully dowloaded data from  bucket");
                    res.attachment(params.Key); // Set Filename
                    res.type(data.ContentType); // Set FileType
                    res.send(data.Body);        // Send File Buffer
                }
            });
        }
        else res.end(JSON.stringify({ error: true }))
    }
})

// Send creation blog page to user
app.get("/createpost", (req, res) => {
    if ((req.session.email !== undefined && req.session.logged)) res.render("createpost.hbs", { logged: (!req.session.logged) ? false : true })
    else res.render("nopermissions.hbs")
})

// Send login page to user
app.get("/login", (req, res) => {
    if (!req.session.logged) res.render("auth/login.hbs")
    else res.redirect(req.baseUrl + "/")
})

// Send register page to user
app.get("/register", (req, res) => {
    res.render("auth/register.hbs")
})

// Listen port
app.listen(port, async () => {
    await pool.connect();
    logger.info(`Example app listening on port ${port}`)
    console.log(`Example app listening on port ${port}`)
})

// Parse blog from database to user request
function createDataFromDatabse(posts) {
    let publicPosts = []
    posts = posts.rows
    // Check if blog is not empty
    if (posts.length > 0) {
        //Set basic variables
        let lastTitle = posts[0]
        let blogContent = []
        let findedText = false
        let description = ''

        // Enumerate on available posts
        for (let post of posts) {
            // Check if new blog 
            if (post.title !== lastTitle.title) {
                logger.info(lastTitle.id)
                // Save the previous blog to array
                publicPosts.push({ id: lastTitle.id, description: description, public: post.public, title: lastTitle.title, author: lastTitle.firstName + " " + lastTitle.lastName, thumbnail: lastTitle.thumbnail, blogContent: blogContent })

                lastTitle = post
                blogContent = []
                findedText = false
                description = ''
            }

            // Create section 
            if (post.type !== 'text') {

                // Create file section
                blogContent.push({ type: post.type, order: post.orderOf, file: post.filename + "." + post.extension, size: post.size })
            } else {
                blogContent.push({ type: post.type, order: post.orderOf, text: post.text })

                // Extract first 25 words to description
                if (!findedText) {
                    let allWorlds = post.text.split(" ")
                    let text = ''
                    if (allWorlds.length > 25) {
                        for (let x = 0; x < 25; x++) {
                            text += allWorlds[x] + " "
                        }
                    } else {
                        for (let x = 0; x < allWorlds.length; x++) {
                            text += allWorlds[x] + " "
                        }
                    }
                    description = text
                    findedText = true
                }
            }
        }
        // Save last blog
        publicPosts.push({ id: lastTitle.id, public: lastTitle.public, description: description, title: lastTitle.title, author: lastTitle.firstName + " " + lastTitle.lastName, thumbnail: lastTitle.thumbnail, blogContent: blogContent })
    }

    // Return parsed array
    return publicPosts
}

// Make Id 
function makeid(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() *
            charactersLength));
    }
    return result;
}