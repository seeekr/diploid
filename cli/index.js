#!/usr/bin/env node

require('yargs')
    .command(require('./cmd/init'))
    .command(require('./cmd/log'))
    .command(require('./cmd/deploy'))
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .parse()
