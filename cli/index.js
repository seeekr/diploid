#!/usr/bin/env node

require('yargs')
    .command(require('./cmd/init'))
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .parse()
